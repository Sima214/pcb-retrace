/* inspector.js - Visual Trace Tracking (v6) */

class Inspector {
    // #region Config & Utilities
    static ACTIVE_NETNODE_PRIMARY_COLOR = '#d118a9dd';
    static ACTIVE_NETNODE_PROJECTED_COLOR = '#33806cdd';
    static NETNODE_COLOR = '#2b7a4899';
    static BOMNODE_COLOR = '#795c0099';
    static CURSOR_MASTER_COLOR = '#ef4444dd';
    static CURSOR_PROJECTED_COLOR = '#3b82f6dd';
    static NON_INTERACTABLE_NODE_WHITE = '#eeeeeedd';

    static TRACE_PRIMARY_COLOR = '#f5610bcc';
    static TRACE_PROJECTED_COLOR = '#3b82f644';
    static ACTIVE_TRACE_COLOR = '#10b981dd';

    static MARKER_S = 40;
    static MARKER_R = 18;

    static TRACE_DEFAULT_WIDTH = 16;

    async getImageResolution(img) {
        if (!img || !img.blob) return { w: 0, h: 0 };
        if (this.resolutionCache[img.id]) return this.resolutionCache[img.id];
        try {
            const bmp = await createImageBitmap(img.blob);
            const res = { w: bmp.width, h: bmp.height };
            bmp.close();
            this.resolutionCache[img.id] = res;
            return res;
        } catch (e) { return { w: 0, h: 0 }; }
    }

    // #endregion
    // #region Initialization & Setup
    constructor(db, cv) {
        this.db = db;
        this.cv = cv;
        this.grid = document.getElementById('inspect-grid');
        this.sidebarList = document.getElementById('inspect-layers');
        this.activeNetEl = document.getElementById('inspect-active-net');

        this.viewers = {};
        this.visibleIds = new Set();
        this.activeNet = null;
        this.activeTrace = null; // The trace currently being edited.
        this.masterId = null;

        this.projectedNetNodeCache = {}; // Cache for calculated node positions
        this.inactiveNetCache = {}; // Cache for all nets except the active one
        this.bomCache = {}; // Cache for projected BOM coordinates
        this.traceCache = {}; // Render cache for all traces except the one being edited.

        // Cache for image dimensions to avoid async bitmap creation on every render
        this.resolutionCache = {};

        // Compile canvas shapes ahead of time.
        let nodeMarker = new Path2D();
        {
            const s = Inspector.MARKER_S, r = Inspector.MARKER_R;
            nodeMarker.moveTo(0, 0);
            nodeMarker.lineTo(0, -s + r);
            nodeMarker.arcTo(0, -s, s, -s, r);
            nodeMarker.lineTo(s - r, -s);
            nodeMarker.arcTo(s, -s, s, 0, r);
            nodeMarker.lineTo(s, -r);
            nodeMarker.arcTo(s, 0, 0, 0, r);
            nodeMarker.closePath();
        }
        this.canvasShapes = {
            nodeMarker: nodeMarker,
        };

        // Initialization State Lock
        this.initPromise = null;
        this.needsSync = false;
    }

    async selectBestMobilePair(sortedImgs, selectionSet) {
        let topCand = [], botCand = [], otherCand = [];

        for (const img of sortedImgs) {
            const n = img.name.toLowerCase();
            if (n.includes('top') || n.includes('front')) topCand.push(img);
            else if (n.includes('bot') || n.includes('back')) botCand.push(img);
            else otherCand.push(img);
        }

        let bestPair = null;
        let maxCombinedRes = 0;

        if (topCand.length > 0 && botCand.length > 0) {
            for (const t of topCand) {
                const paths = await ImageGraph.solvePaths(t.id, this.cv, this.db);
                const reachableIds = new Set(paths.map(p => p.id));
                const resT = await this.getImageResolution(t);
                const pxT = resT.w * resT.h;

                for (const b of botCand) {
                    if (reachableIds.has(b.id)) {
                        const resB = await this.getImageResolution(b);
                        const totalPx = pxT + (resB.w * resB.h);
                        if (totalPx > maxCombinedRes) {
                            maxCombinedRes = totalPx;
                            bestPair = [t, b];
                        }
                    }
                }
            }
        }

        if (!bestPair) {
            const pickBest = async (list) => {
                if (list.length === 0) return null;
                let best = list[0];
                let maxP = 0;
                for (const i of list) {
                    const r = await this.getImageResolution(i);
                    if ((r.w * r.h) > maxP) { maxP = r.w * r.h; best = i; }
                }
                return best;
            };
            const t = await pickBest(topCand);
            const b = await pickBest(botCand);
            if (t) selectionSet.add(t.id);
            if (b) selectionSet.add(b.id);
        } else {
            selectionSet.add(bestPair[0].id);
            selectionSet.add(bestPair[1].id);
        }

        if (selectionSet.size < 2) {
            const others = [...topCand, ...botCand, ...otherCand].filter(x => !selectionSet.has(x.id));
            for (const o of others) {
                if (selectionSet.size >= 2) break;
                selectionSet.add(o.id);
            }
        }
    }

    /**
 * Wrapper to prevent race conditions when switchView calls
 * init() and loadNet() is called immediately after
 */
    async init() {
        if (this.initPromise) return this.initPromise;
        this.initPromise = this._performInit();
        try {
            await this.initPromise;
        } finally {
            this.initPromise = null;
        }
    }

    async _performInit() {
        this.bomCache = {}; // Clear cache on re-init
        this.backImagesCache = null; // Clear back-side cache
        this.sidebarList.innerHTML = '';

        const newNetBtn = document.querySelector('button[onclick="inspector.startNewNet()"]');
        if (newNetBtn) newNetBtn.style.display = 'none';

        const sortedImgs = [...bomImages].sort((a, b) => {
            const nA = a.name.toLowerCase(), nB = b.name.toLowerCase();
            if (nA.includes('top')) return -1;
            if (nB.includes('top')) return 1;
            return nA.localeCompare(nB);
        });

        sortedImgs.forEach(img => {
            const row = document.createElement('div');
            row.style.cssText = "display:grid; grid-template-columns: 20px 1fr; align-items:center; gap:5px; color:#334155; font-size:0.85rem; border-bottom:1px solid #f1f5f9; padding-bottom:4px;";

            const chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.dataset.id = img.id;
            chk.onchange = () => this.toggleLayer(img.id, chk.checked);

            const label = document.createElement('span');
            label.innerText = img.name;
            label.style.cssText = "white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
            label.title = img.name;

            row.appendChild(chk);
            row.appendChild(label);
            this.sidebarList.appendChild(row);
        });

        if (this.visibleIds.size === 0) {
            const isDesktop = window.matchMedia("(min-width: 800px)").matches;
            const nextVisible = new Set();

            if (isDesktop) {
                sortedImgs.forEach(img => nextVisible.add(img.id));
            } else {
                await this.selectBestMobilePair(sortedImgs, nextVisible);
            }

            this.visibleIds = nextVisible;
            Array.from(this.sidebarList.querySelectorAll('input')).forEach(chk => {
                chk.checked = this.visibleIds.has(chk.dataset.id);
            });
        } else {
            Array.from(this.sidebarList.querySelectorAll('input')).forEach(chk => {
                chk.checked = this.visibleIds.has(chk.dataset.id);
            });
        }

        this.updateNetUI();
        this.updateTraceUI();
        await this.renderGrid();
    }

    // #endregion
    // #region Input Handling & Interaction
    static nodeMarkerSDF(x, y) {
        // Approximate the teardrop-like Path2D with a partially rounded box.
        const s = Inspector.MARKER_S;
        const cx = x - s / 2;
        const cy = y + s / 2;

        const r = (cx < 0 && cy > 0) ? 0 : Inspector.MARKER_R;
        const b = s / 2 - r;

        const absX = Math.abs(cx) - b;
        const absY = Math.abs(cy) - b;
        // Reminder that hypot is glsl's length.
        return Math.hypot(Math.max(absX, 0), Math.max(absY, 0)) + Math.min(Math.max(absX, absY), 0) - r;
    }
    getInteractableNetNodeAt(imgId, x, y) {
        if (!this.activeNet || !this.activeNet.nodes) return [null, -1];

        const cosR = Math.cos(Math.PI / 4);
        const sinR = Math.sin(Math.PI / 4);

        // Pick the visually first top node for which the point (x,y) is inside.
        for (let i = this.activeNet.nodes.length - 1; i >= 0; i--) {
            const node = this.activeNet.nodes[i];
            if (node.imgId !== imgId) continue;

            // 1. Translate click point to be relative to node anchor.
            const dx = x - node.x;
            const dy = y - node.y;
            // 2. Rotate the point by +45 degrees to align with the shape's original orientation for SDF evaluation.
            const rotX = dx * cosR - dy * sinR;
            const rotY = dx * sinR + dy * cosR;

            // Calculate the signed distance to current node and perform the hit test.
            const d = Inspector.nodeMarkerSDF(rotX, rotY);
            if (d <= 0) return [node, i];
        }

        return [null, -1];
    }

    async handleNodeClick(imgId, hitNode, hitNodeIdx) {
        const res = await requestInput("Edit Node", "Node Name", hitNode.label, {
            extraBtn: { label: 'Delete', value: '__DELETE__', class: 'danger' },
            helpHtml: (typeof PIN_HELP_HTML !== 'undefined') ? PIN_HELP_HTML : null,
            validate: validateNetName,
            validateArgs: this.activeNet ? [this.activeNet.id] : null
        });
        if (res === '__DELETE__') {
            this.activeNet.nodes.splice(hitNodeIdx, 1);
        } else if (res) {
            hitNode.label = res;
        }
        if (res) {
            this.updateNetUI();
            Object.values(this.viewers).forEach(v => v.draw());
        }
    }

    async handleAddNode(imgId, x, y) {
        const nextIdx = this.activeNet ? this.activeNet.nodes.length + 1 : 1;
        let defaultLabel = `P${nextIdx}`;

        // Async Smart Suggestion
        const smartLabel = await this.getSuggestedLabel(imgId, x, y);
        if (smartLabel) defaultLabel = smartLabel;

        const label = await requestInput("Add Node", "Pad/Pin Name", defaultLabel, {
            helpHtml: (typeof PIN_HELP_HTML !== 'undefined') ? PIN_HELP_HTML : null,
            validate: validateNetName,
            validateArgs: this.activeNet ? [this.activeNet.id] : null
        });

        if (label) {
            if (!this.activeNet) this.startNewNet();
            this.activeNet.nodes.push({ id: uuid(), imgId: imgId, x: Math.round(x), y: Math.round(y), label: label });
            this.updateNetUI();
            Object.values(this.viewers).forEach(v => v.draw());
        }
    }

    toggleLayer(id, isVisible) {
        if (isVisible) this.visibleIds.add(id);
        else this.visibleIds.delete(id);
        this.renderGrid();
    }

    hideCrosshair() {
        this.masterId = null;
        this.cursorState = null;
        Object.values(this.viewers).forEach(v => {
            v.cursorPos = null; v.setDimmed(false); v.draw();
        });
    };

    async syncCursors(masterId, mx, my, forceRefresh = false) {
        if (this.activeTrace && masterId !== this.activeTrace.imgId) {
            this.cancelTrace();
        }

        if (mx !== null && my !== null) {
            this.cursorState = { masterId, mx, my };
        } else if (!forceRefresh && !this.cursorState) {
            return;
        }

        const path = await ImageGraph.solvePaths(masterId, this.cv, this.db);
        const connectedIds = new Set(path.map(p => p.id));
        connectedIds.add(masterId);

        for (const [id, viewer] of Object.entries(this.viewers)) {
            if (id === masterId) {
                viewer.setDimmed(false);
                viewer.draw();
                continue;
            }

            if (!connectedIds.has(id)) {
                viewer.cursorPos = null;
                viewer.setDimmed(true);
                viewer.draw();
                continue;
            }

            const targetPath = path.find(p => p.id === id);

            if (mx !== null && my !== null && targetPath) {
                const pt = this.cv.projectPoint(mx, my, targetPath.H);
                if (pt) {
                    viewer.cursorPos = pt;
                    const w = viewer.bmp ? viewer.bmp.width : 1000;
                    const h = viewer.bmp ? viewer.bmp.height : 1000;

                    const inside = (pt.x >= 0 && pt.y >= 0 && pt.x <= w && pt.y <= h);
                    viewer.setDimmed(!inside);

                    if (inside && viewer.bmp) {
                        const k = viewer.t.k;
                        const tx = viewer.t.x;
                        const ty = viewer.t.y;
                        const imgX = viewer.isMirrored ? (w - pt.x) : pt.x;
                        const screenX = imgX * k + tx;
                        const screenY = pt.y * k + ty;
                        const cvsW = viewer.canvas.width;
                        const cvsH = viewer.canvas.height;
                        const padX = cvsW * 0.25;
                        const padY = cvsH * 0.25;

                        let dx = 0, dy = 0;
                        if (screenX > cvsW - padX) dx = (cvsW - padX) - screenX;
                        else if (screenX < padX) dx = padX - screenX;
                        if (screenY > cvsH - padY) dy = (cvsH - padY) - screenY;
                        else if (screenY < padY) dy = padY - screenY;

                        if (dx !== 0 || dy !== 0) {
                            viewer.t.x += dx;
                            viewer.t.y += dy;
                        }
                    }
                } else {
                    viewer.cursorPos = null;
                    viewer.setDimmed(true);
                }
            } else {
                viewer.setDimmed(false);
            }
            viewer.draw();
        }
    }
    // #endregion
    // #region Render Cache Management
    async updateInactiveNetNodeCache() {
        // Fetch all nets and filter in memory.
        const allNets = await this.db.getNets();
        const activeNetId = this.activeNet ? this.activeNet.id : null;
        const inactiveNets = allNets.filter(n => n.projectId === currentBomId && n.id !== activeNetId);

        const newCache = {};
        for (const id of this.visibleIds) {
            newCache[id] = [];
        }

        // For each net:
        for (const net of inactiveNets) {
            // For each node in the current net:
            for (const node of net.nodes) {
                // If node.imgId is a visible layer, then add to cache.
                if (this.visibleIds.has(node.imgId)) {
                    newCache[node.imgId].push({ x: node.x, y: node.y, orig: node });
                }
            }
        }

        this.inactiveNetCache = newCache;
    }

    async updateProjectedNetNodeCache() {
        // Reset net node render state and skip work if no actual nodes exist.
        if (!this.activeNet || !this.activeNet.nodes) {
            this.projectedNetNodeCache = {};
            return false;
        }

        const newCache = {};
        const layerPaths = {};

        // For currently visible layers:
        for (const visId of this.visibleIds) {
            // Initialize cache.
            newCache[visId] = [];
            // Pre-calculate projections.
            layerPaths[visId] = await ImageGraph.solvePaths(visId, this.cv, this.db);
        }

        // This triggers whenever a new net is saved.
        if (!this.activeNet || !this.activeNet.nodes) {
            console.log("FIXME: nodes disappeared while waiting for `solvePaths`!");
            this.projectedNetNodeCache = {};
            return false;
        }

        for (const node of this.activeNet.nodes) {
            // Inferred/Projected Nodes.
            for (const p of layerPaths[node.imgId]) {
                const proj = this.cv.projectPoint(node.x, node.y, p.H);
                if (proj) {
                    newCache[p.id].push({
                        x: proj.x, y: proj.y, orig: node
                    });
                }
            }
        }

        this.projectedNetNodeCache = newCache;
        return true;
    }
    async updateProjectedNetNodeCacheAndRedraw() {
        if (await this.updateProjectedNetNodeCache()) {
            Object.values(this.viewers).forEach(v => v.draw());
        }
    }

    async updateTraceCache() {
        const newCache = {};
        const layerPaths = {};

        // For currently visible layers precalculate projection matrices.
        for (const visId of this.visibleIds) {
            newCache[visId] = [];
            layerPaths[visId] = await ImageGraph.solvePaths(visId, this.cv, this.db);
        }

        // Load traces from database.
        const allTraces = await this.db.getTraces();

        /**
         * NOTE: Each trace's `points` member is a set of vertices that define a line strip.
         */
        for (const trace of allTraces) {
            // 1. Direct/Primary view:
            newCache[trace.imgId].push({
                points: trace.points,
                isPrimary: true,
                orig: trace
            });
            // 2. Projected views:
            for (const p of layerPaths[trace.imgId]) {
                const projPoints = [];
                // projectPoint returns null when the matrice parameter is invalid or the projection is ill-defined.
                trace.points.forEach(pt => {
                    const proj = this.cv.projectPoint(pt.x, pt.y, p.H);
                    if (proj) projPoints.push(proj);
                });
                if (projPoints.length > 0) {
                    newCache[p.id].push({
                        points: projPoints, isPrimary: false, orig: trace
                    });
                }
            }
        }

        this.traceCache = newCache;
        // console.log(newCache);
        return true;
    }

    async updateTraceCacheAndRedraw() {
        if (await this.updateTraceCache()) {
            Object.values(this.viewers).forEach(v => v.draw());
        }
    }
    // #endregion
    // #region Rendering & Grid Management
    async renderGrid() {
        const savedStates = {};
        if (this.viewers) {
            Object.entries(this.viewers).forEach(([id, v]) => {
                if (v.t) savedStates[id] = { t: { ...v.t }, interacted: v.userInteracted || false };
            });
        }

        this.grid.innerHTML = '';
        this.viewers = {};

        if (this.visibleIds.size === 0) {
            this.grid.innerHTML = '<div style="display:flex; align-items:center; justify-content:center; color:#64748b; height:100%;">Select layers to inspect</div>';
            return;
        }

        // --- SMART GRID CALCULATION (Aspect Ratio Aware) ---
        const count = this.visibleIds.size;
        const rect = this.grid.getBoundingClientRect();
        const width = rect.width || window.innerWidth;
        const height = rect.height || window.innerHeight;

        // 1. Calculate Average Aspect Ratio
        let totalAR = 0;
        let validARCount = 0;
        for (const id of this.visibleIds) {
            const imgRec = bomImages.find(i => i.id === id);
            if (imgRec) {
                const res = await this.getImageResolution(imgRec);
                if (res.w > 0 && res.h > 0) {
                    totalAR += (res.w / res.h);
                    validARCount++;
                }
            }
        }
        const avgAR = (validARCount > 0) ? (totalAR / validARCount) : 1.5;

        // 2. Solve for Best Layout (Maximize Scale)
        let bestCols = 1;
        let maxScale = 0;

        for (let c = 1; c <= count; c++) {
            const r = Math.ceil(count / c);
            const cellW = width / c;
            const cellH = height / r;
            const scale = Math.min(cellW / avgAR, cellH);

            if (scale > maxScale) {
                maxScale = scale;
                bestCols = c;
            }
        }

        const cols = bestCols;
        const rows = Math.ceil(count / cols);

        this.grid.style.display = 'grid';
        this.grid.style.width = '100%';
        this.grid.style.height = '100%';
        this.grid.style.boxSizing = 'border-box';
        this.grid.style.gap = '2px';
        this.grid.style.background = '#000';
        this.grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
        this.grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;

        if (!this.masterId || !this.visibleIds.has(this.masterId)) {
            this.masterId = this.visibleIds.values().next().value;
        }

        for (const id of this.visibleIds) {
            const imgRec = bomImages.find(i => i.id === id);
            if (!imgRec) continue;

            const cell = document.createElement('div');
            cell.style.cssText = "position:relative; overflow:hidden; border:1px solid #334155; background:#000; width:100%; height:100%; min-width:0; min-height:0;";

            const cvs = document.createElement('canvas');
            cvs.id = `inspect-cvs-${id}`;
            cvs.style.cssText = "display:block; position:absolute; top:0; left:0; width:100%; height:100%; outline:none;";
            cvs.tabIndex = 0;
            cell.appendChild(cvs);

            const lbl = document.createElement('div');
            lbl.innerText = imgRec.name;
            lbl.style.cssText = "position:absolute; top:5px; left:5px; background:rgba(0,0,0,0.7); padding:2px 6px; font-size:0.7rem; pointer-events:none; border-radius:3px; color:white;";
            cell.appendChild(lbl);

            this.grid.appendChild(cell);

            let wasActiveBeforeDown = false;
            let stateRestored = false;

            const viewer = new PanZoomCanvas(cvs.id,
                // Redraw handler.
                (ctx, k) => this.drawOverlay(id, ctx, k),
                // Click handler.
                async (x, y, e) => {
                    if (e.button !== 0) return;
                    if (this.activeTrace) {
                        if (this.activeTrace.imgId === id) {
                            this.appendTrace({ x: x, y: y });
                        } else {
                            this.cancelTrace();
                        }
                    } else if (wasActiveBeforeDown) {
                        const [hitNode, hitNodeIdx] = this.getInteractableNetNodeAt(id, x, y);
                        if (hitNode) {
                            const now = Date.now();
                            if (viewer.lastClickTime && (now - viewer.lastClickTime < 300)) {
                                await this.handleNodeClick(id, hitNode, hitNodeIdx);
                            }
                            viewer.lastClickTime = now;
                        } else {
                            await this.handleAddNode(id, x, y);
                        }
                    }
                },
                // Drag Handler
                (dx, dy, mode, idx) => {
                    // Verify that the active net is initialized and has nodes.
                    if (!this.activeNet || !this.activeNet.nodes || !this.activeNet.nodes.length) {
                        return -1;
                    }
                    if (mode === 'check') {
                        // Only allows dragging of primary nodes.
                        const [hitNode, hitNodeIdx] = this.getInteractableNetNodeAt(id, dx, dy);
                        return hitNodeIdx;
                    } else if (mode === 'move') {
                        const n = this.activeNet.nodes[idx];
                        if (n) {
                            n.x += dx;
                            n.y += dy;
                            viewer.draw();
                            this.needsSync = true;
                        }
                    }
                }
            );

            viewer.userInteracted = false;

            viewer.onPointerDown = (e) => {
                /** 
                 * NOTE: This event gets suppressed when clicking on the active canvas,
                 * as the net node adding logic takes priority.
                 */
                viewer.userInteracted = true;
                cvs.focus();
                if (e.isPrimary || e.button === 0) {
                    wasActiveBeforeDown = (this.masterId === id);
                    if (this.masterId !== id) {
                        this.masterId = id;
                        this.syncCursors(id, null, null, true);
                    }
                    const pt = viewer.getImgCoords(e.clientX, e.clientY);
                    this.syncCursors(id, pt.x, pt.y);
                }
            };

            // Trigger re-projection when drag ends
            cvs.addEventListener('pointerup', () => {
                if (this.needsSync) {
                    this.updateProjectedNetNodeCacheAndRedraw();
                    this.needsSync = false;
                }
            });

            cvs.addEventListener('wheel', () => { viewer.userInteracted = true; });

            viewer.onMouseMove = (x, y) => {
                if (this.masterId === id) {
                    this.syncCursors(id, x, y);
                    const [hitNode, hitNodeIdx] = this.getInteractableNetNodeAt(id, x, y);
                    viewer.canvas.style.cursor = hitNode ? 'pointer' : 'default';
                } else {
                    viewer.canvas.style.cursor = 'default';
                }
            };

            const updateView = () => {
                if (!viewer.bmp || cvs.width < 20 || cvs.height < 20) return;
                if (savedStates[id] && savedStates[id].interacted && !stateRestored) {
                    viewer.t = savedStates[id].t;
                    stateRestored = true;
                    viewer.userInteracted = true;
                    viewer.draw();
                }
                else if (!viewer.userInteracted) {
                    viewer.fit();
                }
            };

            viewer.onResize = (w, h) => updateView();

            cvs.addEventListener('keydown', (e) => {
                // No modifiers keys pressed:
                if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.repeat) {
                    // If we are in trace draw mode:
                    if (this.activeTrace) {
                        if (e.code === "KeyX" || e.code === "KeyQ" || e.code === "Escape") {
                            // Cancel current trace.
                            e.stopPropagation();
                            this.cancelTrace();
                        } else if (e.code === "Enter") {
                            // Commit current trace.
                            e.stopPropagation();
                            let coords = null;
                            if (this.cursorState && this.cursorState.masterId === this.activeTrace.imgId) {
                                coords = { x: this.cursorState.mx, y: this.cursorState.my };
                            }
                            this.saveTrace(coords);
                        }
                    }
                    else if (e.code === "KeyX") {
                        this.hideCrosshair(e);
                        e.stopPropagation();
                    }
                }
            });

            cvs.addEventListener('contextmenu', (e) => {
                const coords = viewer.getImgCoords(e.clientX, e.clientY);
                /**
                 * If currently drawing traces, register clicks
                 * only if cursor in the starting canvas/view.
                 */
                if (this.activeTrace && this.activeTrace.imgId === id) {
                    e.preventDefault(); e.stopPropagation();
                    this.saveTrace(coords);
                } else if (!this.activeTrace) {
                    e.preventDefault(); e.stopPropagation();
                    this.startTrace(id, coords);
                } else {
                    // console.log("Trace out of bounds - on another view!");
                }
            });

            this.viewers[id] = viewer;

            try {
                const bmp = await createImageBitmap(imgRec.blob);
                viewer.setImage(bmp);
                updateView();

                if (imgRec.name.toLowerCase().includes('bot') && !imgRec.name.toLowerCase().includes('top')) {
                    viewer.setMirror(true);
                }
            } catch (e) { console.error("Inspector img load error", e); }
        }

        // Prepare render cache.
        this.updateInactiveNetNodeCache();
        this.updateProjectedNetNodeCache();
        // Initialize crosshair to default state.
        if (this.masterId) {
            this.viewers[this.masterId].canvas.focus();
            this.syncCursors(this.masterId, null, null, true);
        }
    }

    drawOverlay(id, ctx, k) {
        const viewer = this.viewers[id];
        if (!viewer) return;
        const ik = 1 / k;

        const isMirrored = viewer.isMirrored && viewer.bmp;
        const bmpWidth = isMirrored ? viewer.bmp.width : 0;

        const o = Inspector.MARKER_S / 2;

        // Render committed traces.
        if (this.traceCache[id]) {
            ctx.save();
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            // Let the native code handle mirroring, as we don't have to deal with text, unlike with nodes.
            if (isMirrored) {
                ctx.translate(bmpWidth, 0);
                ctx.scale(-1, 1);
            }

            for (const t of this.traceCache[id]) {
                ctx.strokeStyle = t.isPrimary ? Inspector.TRACE_PRIMARY_COLOR : Inspector.TRACE_PROJECTED_COLOR;
                ctx.fillStyle = ctx.strokeStyle;
                const pts = t.points;
                // TODO: DPI compensation.
                const w = t.orig.width ? t.orig.width : Inspector.TRACE_DEFAULT_WIDTH;

                // Draw line segments from line strip information.
                if (pts.length > 1) {
                    ctx.beginPath();
                    ctx.lineWidth = w;
                    ctx.moveTo(pts[0].x, pts[0].y);
                    for (let i = 1; i < pts.length; i++) {
                        ctx.lineTo(pts[i].x, pts[i].y);
                    }
                    ctx.stroke();
                } else if (pts.length === 1) {
                    ctx.beginPath();
                    ctx.arc(pts[0].x, pts[0].y, w / 2, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
            ctx.restore();
        }

        // Common draw parameters for all net nodes.
        ctx.save();
        ctx.lineWidth = 1.5 * ik;
        ctx.strokeStyle = 'white';
        ctx.fillStyle = 'white';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 15px sans-serif';

        // Make non-interactable nodes distinct via a lighter dashed border.
        ctx.strokeStyle = Inspector.NON_INTERACTABLE_NODE_WHITE;
        ctx.setLineDash([3 * ik, 3 * ik]);

        // Render primary/direct BOM.
        if (bomData) {
            for (const c of bomData) {
                if (c.imgId === id && c.x !== undefined && c.y !== undefined) {
                    let drawX = isMirrored ? bmpWidth - c.x : c.x;

                    ctx.save();
                    ctx.translate(drawX, c.y);
                    ctx.rotate(-Math.PI / 4);
                    ctx.fillStyle = Inspector.BOMNODE_COLOR;
                    ctx.fill(this.canvasShapes.nodeMarker);
                    ctx.stroke(this.canvasShapes.nodeMarker);

                    ctx.translate(o, -o);
                    ctx.rotate(Math.PI / 4);
                    ctx.fillStyle = Inspector.NON_INTERACTABLE_NODE_WHITE;
                    ctx.fillText(c.label, 0, 0);
                    ctx.restore();
                }
            }
        }

        // Render inactive primary net nodes.
        if (this.inactiveNetCache[id]) {
            for (const item of this.inactiveNetCache[id]) {
                let drawX = isMirrored ? bmpWidth - item.x : item.x;

                ctx.save();
                ctx.translate(drawX, item.y);
                ctx.rotate(-Math.PI / 4);
                ctx.fillStyle = Inspector.NETNODE_COLOR;
                ctx.fill(this.canvasShapes.nodeMarker);
                ctx.stroke(this.canvasShapes.nodeMarker);

                ctx.translate(o, -o);
                ctx.rotate(Math.PI / 4);
                ctx.fillStyle = Inspector.NON_INTERACTABLE_NODE_WHITE;
                ctx.fillText(item.orig.label, 0, 0);
                ctx.restore();
            }
        }

        ctx.strokeStyle = 'white';
        ctx.setLineDash([]);

        // Render active primary net nodes.
        if (this.activeNet && this.activeNet.nodes) {
            for (const n of this.activeNet.nodes) {
                if (n.imgId === id) {
                    let drawX = isMirrored ? bmpWidth - n.x : n.x;

                    ctx.save();
                    ctx.translate(drawX, n.y);
                    ctx.rotate(-Math.PI / 4);
                    ctx.fillStyle = Inspector.ACTIVE_NETNODE_PRIMARY_COLOR;
                    ctx.fill(this.canvasShapes.nodeMarker);
                    ctx.stroke(this.canvasShapes.nodeMarker);

                    ctx.translate(o, -o);
                    ctx.rotate(Math.PI / 4);
                    ctx.fillStyle = 'white';
                    ctx.fillText(n.label, 0, 0);
                    ctx.restore();
                }
            }
        }

        // Render active projected net nodes.
        if (this.projectedNetNodeCache[id]) {
            for (const n of this.projectedNetNodeCache[id]) {
                let drawX = isMirrored ? bmpWidth - n.x : n.x;

                ctx.save();
                ctx.translate(drawX, n.y);
                ctx.rotate(-Math.PI / 4);
                ctx.fillStyle = Inspector.ACTIVE_NETNODE_PROJECTED_COLOR;
                ctx.fill(this.canvasShapes.nodeMarker);
                ctx.stroke(this.canvasShapes.nodeMarker);

                ctx.translate(o, -o);
                ctx.rotate(Math.PI / 4);
                ctx.fillStyle = 'white';
                ctx.fillText(n.orig.label, 0, 0);
                ctx.restore();
            }
        }

        // End of node rendering.
        ctx.restore();

        // Draw new/active trace.
        if (this.activeTrace && this.cursorState && this.activeTrace.imgId === id) {
            // Retrieve current cursor position.
            const cx = this.cursorState.mx;
            const cy = this.cursorState.my;

            ctx.save();
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            if (isMirrored) {
                ctx.translate(bmpWidth, 0);
                ctx.scale(-1, 1);
            }

            ctx.strokeStyle = Inspector.ACTIVE_TRACE_COLOR;
            ctx.fillStyle = Inspector.ACTIVE_TRACE_COLOR;
            const pts = this.activeTrace.points;
            const w = this.activeTrace.width ? this.activeTrace.width : Inspector.TRACE_DEFAULT_WIDTH;

            // Starting from the current cursor position, draw the line segments in reverse.
            ctx.beginPath();
            ctx.lineWidth = w;
            ctx.moveTo(cx, cy);
            for (let i = pts.length - 1; i >= 0; i--) {
                ctx.lineTo(pts[i].x, pts[i].y);
            }
            ctx.stroke();

            ctx.restore();
        }

        { // Draw crosshairs.
            let cx, cy, color;
            if (this.cursorState && this.cursorState.masterId === id) {
                cx = this.cursorState.mx; cy = this.cursorState.my;
                if (isMirrored) cx = bmpWidth - cx;
                color = Inspector.CURSOR_MASTER_COLOR;
            } else if (viewer.cursorPos) {
                cx = viewer.cursorPos.x; cy = viewer.cursorPos.y;
                if (isMirrored) cx = bmpWidth - cx;
                color = Inspector.CURSOR_PROJECTED_COLOR;
            }

            if (cx !== undefined) {
                const len = 100000;
                ctx.lineWidth = 1 * ik;
                ctx.strokeStyle = color;
                ctx.beginPath();
                ctx.moveTo(cx - len, cy); ctx.lineTo(cx + len, cy);
                ctx.moveTo(cx, cy - len); ctx.lineTo(cx, cy + len);
                ctx.stroke();
            }
        }

        // TODO: No reason that we have to redraw all the nodes if only the crosshairs location changed.
    }
    // #endregion
    // #region BOM & Net Node Labeling Heuristics
    async getProjectedComponents(targetImgId) {
        if (this.bomCache[targetImgId]) return this.bomCache[targetImgId];

        const projected = [];

        // 1. Calculate paths FROM the target TO everything else
        // We want to answer: "Where is Image X relative to ME (Target)?"
        // This runs Dijkstra once (One-to-Many) instead of Many-to-One
        let pathMap = {};

        if (typeof ImageGraph !== 'undefined') {
            // solvePaths returns H for: Target -> Remote
            const paths = await ImageGraph.solvePaths(targetImgId, this.cv, this.db);

            paths.forEach(p => {
                // To render a Remote component on Target, we need: Remote -> Target
                // So we invert the matrix: inv(Target -> Remote)
                const invH = ImageGraph.invertH(p.H);
                if (invH) pathMap[p.id] = invH;
            });
        }

        // 2. Iterate all components and project them
        if (typeof bomData !== 'undefined') {
            bomData.forEach(c => {
                if (!c.imgId) return;

                // Case A: Component is on the current image (Direct)
                if (c.imgId === targetImgId) {
                    if (c.x !== undefined && c.y !== undefined) {
                        projected.push({ ...c, projX: c.x, projY: c.y });
                    }
                }
                // Case B: Component is on a connected image (Inferred)
                else if (pathMap[c.imgId]) {
                    if (c.x !== undefined && c.y !== undefined) {
                        const H = pathMap[c.imgId];
                        const pt = this.cv.projectPoint(c.x, c.y, H);

                        // Basic sanity bounds to prevent projecting into infinity
                        // (can happen with near-singular matrices or extreme perspective)
                        if (pt && Math.abs(pt.x) < 50000 && Math.abs(pt.y) < 50000) {
                            projected.push({ ...c, projX: pt.x, projY: pt.y });
                        }
                    }
                }
            });
        }

        this.bomCache[targetImgId] = projected;
        return projected;
    }
    async calculateGlobalRotation() {
        // Default to 0 if data missing
        if (typeof currentBomId === 'undefined' || typeof bomData === 'undefined') return 0;

        const allNets = await this.db.getNets();
        const projectNets = allNets.filter(n => n.projectId === currentBomId);

        let totalAngle = 0;
        let count = 0;

        // We only trust 2-pin passive components for orientation
        // (Resistors, Caps, Inductors, Diodes).
        // ICs are complex, Transistors have triangles.
        const SAFE_PREFIXES = ['R', 'C', 'L', 'D', 'VD'];

        projectNets.forEach(net => {
            net.nodes.forEach(node => {
                // Find the component this node belongs to
                // Node label format "R1.1" -> Ref "R1"
                const parts = node.label.split('.');
                if (parts.length !== 2) return;

                const ref = parts[0];

                // Check prefix
                const prefix = ref.match(/^[A-Z]+/);
                if (!prefix || !SAFE_PREFIXES.includes(prefix[0])) return;

                const comp = bomData.find(c => c.label === ref);

                // Critical: We must use coordinates from the SAME image to calculate angle
                if (comp && comp.imgId === node.imgId && comp.x !== undefined) {
                    const dx = node.x - comp.x;
                    const dy = node.y - comp.y;

                    // Calculate raw angle in degrees
                    let deg = Math.atan2(dy, dx) * (180 / Math.PI);

                    // Normalize to deviation from nearest 90-degree axis (-45 to +45)
                    // Examples:
                    // 5 deg -> 5
                    // 85 deg -> -5 (relative to 90)
                    // 175 deg -> -5 (relative to 180)
                    while (deg <= -45) deg += 90;
                    while (deg > 45) deg -= 90;

                    // Filter outliers (e.g. diagonal placement)
                    // User requested up to 15 degrees, we allow 20 for safety
                    if (Math.abs(deg) < 20) {
                        totalAngle += deg;
                        count++;
                    }
                }
            });
        });

        if (count === 0) return 0;

        // Return average rotation in Radians
        const avgDeg = totalAngle / count;
        return avgDeg * (Math.PI / 180);
    }
    async detectBackImages() {
        if (this.backImagesCache) return this.backImagesCache;
        if (typeof currentBomId === 'undefined' || typeof bomImages === 'undefined') return new Set();

        const overlaps = await this.db._tx('overlappedImages', 'readonly', s => s.getAll());

        // 1. Build Adjacency Graph (Partitioning)
        const polarity = {}; // 1 vs -1
        const adj = {};

        overlaps.forEach(ov => {
            if (!adj[ov.fromImageId]) adj[ov.fromImageId] = [];
            if (!adj[ov.toImageId]) adj[ov.toImageId] = [];

            // Determinant < 0 implies reflection (Flip)
            const h = ov.homography;
            const det = (h[0] * h[4]) - (h[1] * h[3]);
            const isFlip = det < 0;

            adj[ov.fromImageId].push({ target: ov.toImageId, isFlip });
            adj[ov.toImageId].push({ target: ov.fromImageId, isFlip });
        });

        // BFS to propagate polarity
        const visited = new Set();
        const queue = [];

        const startImg = bomImages[0];
        if (!startImg) return new Set();

        polarity[startImg.id] = 1;
        queue.push(startImg.id);
        visited.add(startImg.id);

        while (queue.length > 0) {
            const curr = queue.shift();
            const curPol = polarity[curr];

            if (adj[curr]) {
                adj[curr].forEach(edge => {
                    if (!visited.has(edge.target)) {
                        visited.add(edge.target);
                        polarity[edge.target] = edge.isFlip ? -curPol : curPol;
                        queue.push(edge.target);
                    }
                });
            }
        }

        const groupA = new Set(Object.keys(polarity).filter(k => polarity[k] === 1));
        const groupB = new Set(Object.keys(polarity).filter(k => polarity[k] === -1));

        // 2. Heuristic 2: Check existing Resistor Nets (Reliable)
        // Now checks both Pin 1 and Pin 2
        const rot = await this.calculateGlobalRotation();
        const cosR = Math.cos(-rot);
        const sinR = Math.sin(-rot);

        let scoreA = 0; // Positive = A is Top, Negative = A is Back

        const allNets = await this.db.getNets();
        const projectNets = allNets.filter(n => n.projectId === currentBomId);

        for (const net of projectNets) {
            for (const node of net.nodes) {
                // Match R*.1 OR R*.2
                const match = node.label.match(/^(R\d+)\.([12])$/);
                if (!match) continue;

                const ref = match[1];
                const pinSuffix = match[2]; // '1' or '2'

                const comp = bomData.find(c => c.label === ref);

                // Ensure node and component are on the same image
                if (comp && comp.imgId === node.imgId && comp.x !== undefined) {
                    const dx = node.x - comp.x;
                    const dy = node.y - comp.y;

                    // Rotate to align with horizontal axis
                    const rDx = dx * cosR - dy * sinR;

                    // Rule for TOP side:
                    // Pin 1 is Left (<0).
                    // Pin 2 is Right (>0).
                    const isTopBehavior = (pinSuffix === '1') ? (rDx < 0) : (rDx > 0);

                    if (groupA.has(node.imgId)) scoreA += (isTopBehavior ? 1 : -1);
                    else if (groupB.has(node.imgId)) scoreA += (isTopBehavior ? -1 : 1);
                }
            }
        }

        if (scoreA !== 0) {
            this.backImagesCache = scoreA > 0 ? groupB : groupA;
            return this.backImagesCache;
        }

        // 3. Heuristic 1: Count (Fallback)
        if (groupB.size === 0) this.backImagesCache = new Set();
        else if (groupA.size === 0) this.backImagesCache = groupA;
        else this.backImagesCache = (groupA.size <= groupB.size) ? groupA : groupB;

        return this.backImagesCache;
    }
    async checkGlobalLabelUsage(label) {
        // dependency: currentBomId is global from studio.js
        if (!label || typeof currentBomId === 'undefined') return false;

        // 1. Fetch ALL nets (Async)
        // Optimization: In a huge app we'd index this, but filtering memory is fast enough for <10k nets
        const allNets = await this.db.getNets();

        // 2. Filter for current board
        const projectNets = allNets.filter(n => n.projectId === currentBomId);

        // 3. Scan for label collision
        for (const net of projectNets) {
            if (net.nodes && net.nodes.some(n => n.label === label)) {
                return true;
            }
        }
        return false;
    }

    async getSuggestedLabel(imgId, x, y) {
        const HIT_RADIUS = 150;

        // 1. Get Data
        const components = await this.getProjectedComponents(imgId);
        const rotation = await this.calculateGlobalRotation();
        const backImages = await this.detectBackImages();
        const isBack = backImages.has(imgId);

        const cosR = Math.cos(-rotation);
        const sinR = Math.sin(-rotation);

        let bestComp = null;
        let minScore = Infinity;

        // 2. Weighted Scoring Loop
        components.forEach(c => {
            const dx = x - c.projX;
            const dy = y - c.projY;
            const dist = Math.hypot(dx, dy);

            if (dist < HIT_RADIUS) {
                // Rotate vector
                const rDx = dx * cosR - dy * sinR;
                const rDy = dx * sinR + dy * cosR;

                let angleDeg = Math.abs(Math.atan2(rDy, rDx) * (180 / Math.PI));
                angleDeg = angleDeg % 90;
                let deviation = Math.min(angleDeg, 90 - angleDeg);

                const score = dist * (1 + (deviation * 0.1));

                if (score < minScore) {
                    minScore = score;
                    bestComp = c;
                }
            }
        });

        if (!bestComp) return null;

        // 3. Pin Logic
        const bDx = x - bestComp.projX;
        const bDy = y - bestComp.projY;

        const rotDx = bDx * cosR - bDy * sinR;
        const rotDy = bDx * sinR + bDy * cosR;

        // Logic Branch:
        // Top Side: Left/Top is 1 => (rotDx + rotDy) < 0
        // Back Side: Right/Top is 1 => (rotDx - rotDy) > 0
        let isPin1;
        if (isBack) {
            // Back: Favor Right (x>0) and Top (y<0).
            // x - y => pos - neg = pos.
            isPin1 = (rotDx - rotDy) > 0;
        } else {
            // Top: Favor Left (x<0) and Top (y<0).
            // x + y => neg + neg = neg.
            isPin1 = (rotDx + rotDy) < 0;
        }

        const primaryPin = isPin1 ? '1' : '2';
        const secondaryPin = isPin1 ? '2' : '1';

        const labelPrimary = `${bestComp.label}.${primaryPin}`;
        const labelSecondary = `${bestComp.label}.${secondaryPin}`;

        const primaryTaken = await this.checkGlobalLabelUsage(labelPrimary);
        return primaryTaken ? labelSecondary : labelPrimary;
    }
    // #endregion
    // #region Net Management
    async loadNet(net) {
        // Wait for initialization to complete if triggered by switchView()
        if (this.initPromise) {
            await this.initPromise;
        }

        this.activeNet = JSON.parse(JSON.stringify(net));
        this.updateNetUI();

        if (Object.keys(this.viewers).length === 0) {
            await this.renderGrid();
        } else {
            Object.values(this.viewers).forEach(v => v.draw());
        }
    }

    startNewNet() {
        this.activeNet = { id: uuid(), name: "New Net", nodes: [], isNew: true };
        this.updateNetUI();
    }

    async saveNet() {
        if (!this.activeNet) return;
        if (this.activeNet.isNew) {
            const name = await requestInput("Save Net", "Net Name", this.activeNet.name);
            if (name) { this.activeNet.name = name; delete this.activeNet.isNew; }
            else return;
        }
        this.activeNet.projectId = currentBomId;
        await this.db.addNet(this.activeNet);
        this.activeNet = null;
        this.updateNetUI();
        if (window.netManager) window.netManager.render();
    }

    cancelNet() {
        this.activeNet = null;
        this.updateNetUI();
        history.back();
    }

    updateNetUI() {
        if (!this.activeNet) {
            this.activeNetEl.style.display = 'none';
        } else {
            this.activeNetEl.style.cssText = "pointer-events:auto; background:rgba(15, 23, 42, 0.9); padding:4px 10px; border-radius:20px; border:1px solid #334155; display:flex; color:white; align-items:center; gap:8px; box-shadow:0 4px 6px rgba(0,0,0,0.2); backdrop-filter:blur(4px); font-size:0.85rem; height:auto;";
            this.activeNetEl.innerHTML = `
				<span style="font-weight:600; color:#4ade80; max-width:100px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${this.activeNet.name}</span>
				<span style="color:#94a3b8; border-left:1px solid #475569; padding-left:8px; font-size:0.8rem;">${this.activeNet.nodes.length}</span>
				<button class="primary sm-btn" style="padding:1px 8px; font-size:0.75rem; height:24px; min-height:0; line-height:1;" onclick="inspector.saveNet()">Save</button>
				<button class="danger sm-btn" style="padding:0; width:20px; height:20px; min-height:0; border-radius:50%; line-height:1; display:flex; align-items:center; justify-content:center;" onclick="inspector.cancelNet()">×</button>
			`;
        }

        // Ensure inactive nets are synced before redrawing the active state
        this.updateInactiveNetNodeCache().then(() => {
            this.updateProjectedNetNodeCacheAndRedraw();
        });
    }
    // #endregion
    // #region Trace Management
    startTrace(imgId, firstPoint) {
        if (this.activeTrace) {
            return null;
        }
        this.activeTrace = {
            id: uuid(), imgId: imgId, points: [firstPoint],
            width: Inspector.TRACE_DEFAULT_WIDTH
        };
        this.updateTraceUI();
        return this.activeTrace;
    }
    appendTrace(p) {
        if (!this.activeTrace) {
            return false;
        }
        this.activeTrace.points.push(p);
        this.updateTraceUI();
        return true;
    }
    async saveTrace(p) {
        if (!this.activeTrace) {
            return false;
        }
        if (p) {
            this.activeTrace.points.push(p);
        }
        this.activeTrace.projectId = currentBomId;
        await this.db.addTrace(this.activeTrace);
        this.activeTrace = null;
        this.updateTraceUI();
        return true;
    }
    cancelTrace() {
        this.activeTrace = null;
        this.updateTraceUI();
    }
    updateTraceUI() {
        return this.updateTraceCacheAndRedraw();
    }
    // #endregion
}
