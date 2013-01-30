(function(exports) {

    var DEBUG = false;

    function pathFromRegion(ctx, region) {
        region.iter_rectangles(function(rect) {
            ctx.rect(rect.x, rect.y, rect.width, rect.height);
        });
    }

    function sizeElement(elem, w, h) {
        elem.style.width = w + "px";
        elem.style.height = h + "px";
    }

    function positionElement(elem, x, y, w, h) {
        elem.style.position = "absolute";
        elem.style.left = x + "px";
        elem.style.top = y + "px";
        sizeElement(elem, w, h);
    }

    function getEventCoordsInDomElementSpace(event, elem) {
        var box = elem.getBoundingClientRect();
        return { x: event.clientX - box.left,
                 y: event.clientY - box.top };
    }

    var ContextWrapper = new Class({
        initialize: function(serverWindow, ctx) {
            this._serverWindow = serverWindow;
            this._ctx = ctx;
        },

        drawWithContext: function(func) {
            var ctx = this._ctx;
            ctx.beginPath();
            ctx.save();
            this._serverWindow.prepareContext(ctx);
            func(ctx);
            ctx.restore();
        },

        clearDamage: function() {
            this._serverWindow.clearDamage();
        },
    });

    var DEFAULT_BACKGROUND_COLOR = '#ddd';

    var ServerWindow = new Class({
        initialize: function(windowId, server, ctx) {
            this._server = server;
            this.windowId = windowId;

            this.inputWindow = document.createElement("div");
            this.inputWindow.classList.add("inputWindow");
            this.inputWindow._serverWindow = this;

            this._backgroundColor = DEFAULT_BACKGROUND_COLOR;

            // The region of the window that needs to be redrawn, in window coordinates.
            this._damagedRegion = new Region();

            // The region of the screen that the window occupies, in parent coordinates.
            this.shapeRegion = new Region();

            this._ctxWrapper = new ContextWrapper(this, ctx);

            this._properties = {};

            // All child windows, sorted with the top-most window *first*.
            this.children = [];
        },
        finalize: function() {
            this.shapeRegion.finalize();
            this.shapeRegion = null;

            this._damagedRegion.finalize();
            this._damagedRegion = null;
        },
        _iterParents: function(includeSelf, callback) {
            var serverWindow = this;
            if (!includeSelf)
                serverWindow = serverWindow.parentServerWindow;

            while (serverWindow != null) {
                callback(serverWindow);
                serverWindow = serverWindow.parentServerWindow;
            }
        },
        calculateAbsoluteOffset: function(includeSelf) {
            var x = 0, y = 0;
            this._iterParents(includeSelf, function(serverWindow) {
                x += serverWindow.x;
                y += serverWindow.y;
            });
            return { x: x, y: y };
        },
        calculateTransformedShapeRegion: function() {
            var region = new Region();
            var txform = this.calculateAbsoluteOffset(false);
            region.copy(this.shapeRegion);
            region.translate(txform.x, txform.y);
            return region;
        },
        prepareContext: function(ctx) {
            var txform = this.calculateAbsoluteOffset(true);
            ctx.translate(txform.x, txform.y);

            var region = this._damagedRegion;
            pathFromRegion(ctx, region);
            ctx.clip();
        },
        clearDamage: function() {
            // Don't bother trashing our region here as
            // we'll clear it below.
            var txform = this.calculateAbsoluteOffset(true);
            this._damagedRegion.translate(txform.x, txform.y);
            this._server.subtractDamage(this._damagedRegion);
            this._damagedRegion.clear();
        },
        _drawBackground: function(ctx) {
            ctx.fillStyle = this._backgroundColor;
            ctx.fillRect(0, 0, this.width, this.height);
        },
        damage: function(region, ctx) {
            this._damagedRegion.union(this._damagedRegion, region);

            this._ctxWrapper.drawWithContext(this._drawBackground.bind(this));
            this._server.sendEvent({ type: "Expose",
                                     windowId: this.windowId,
                                     ctx: this._ctxWrapper });
        },
        reconfigure: function(x, y, width, height) {
            this.x = x;
            this.y = y;
            this.width = width;
            this.height = height;

            this.shapeRegion.clear();
            this.shapeRegion.init_rect(x, y, width, height);

            positionElement(this.inputWindow, x, y, width, height);

            this._server.sendEvent({ type: "ConfigureNotify",
                                     windowId: this.windowId,
                                     x: x, y: y, width: width, height: height });
        },
        changeAttributes: function(attributes) {
            if (attributes.hasInput !== undefined && this._hasInput != attributes.hasInput) {
                this._hasInput = !!attributes.hasInput;

                if (this._hasInput)
                    this.inputWindow.style.pointerEvents = '';
                else
                    this.inputWindow.style.pointerEvents = 'none';
            }

            if (attributes.backgroundColor !== undefined && this._backgroundColor != attributes.backgroundColor) {
                this._backgroundColor = attributes.backgroundColor || DEFAULT_BACKGROUND_COLOR;
            }
        },
        changeProperty: function(name, value) {
            this._properties[name] = value;
            this._server.sendEvent({ type: "PropertyChanged",
                                     windowId: this.windowId,
                                     name: name, value: value });
        },
        defineCursor: function(cursor) {
            this.inputWindow.style.cursor = cursor;
        },
    });

    var ServerClient = new Class({
        initialize: function(server, client) {
            this._server = server;
            this._client = client;

            // window id => list of event types
            this._eventWindows = {};
        },

        _isInterestedInEvent: function(event) {
            var listeningFor = this._eventWindows[event.windowId];
            return listeningFor && listeningFor.indexOf(event.type) >= 0;
        },
        sendEvent: function(event) {
            if (this._isInterestedInEvent(event))
                this._client.handleEvent(event);
        },
        selectInput: function(windowId, eventTypes) {
            var listeningFor = this._eventWindows[windowId];
            if (!listeningFor)
                listeningFor = this._eventWindows[windowId] = [];

            listeningFor.push.apply(listeningFor, eventTypes);
        },
    });

    var PublicServer = new Class({
        initialize: function(server) {
            this._server = server;
            this.width = this._server.width;
            this.height = this._server.height;
        }
    });

    var publicMethods = [
        'clientConnected',
        'selectInput',
        'createWindow',
        'destroyWindow',
        'reparentWindow',
        'raiseWindow',
        'lowerWindow',
        'configureRequest',
        'changeAttributes',
        'changeProperty',
        'defineCursor',

        // JS extension -- simplifies the case of drawing
        // by letting someone use an existing expose handler.
        // This is the model used by GDK internally.
        'invalidateWindow',
    ];

    publicMethods.forEach(function(methodName) {
        PublicServer.prototype[methodName] = function() {
            return this._server[methodName].apply(this._server, arguments);
        };
    });

    var inputEventMap = {
        "mouseover": "Enter",
        "mouseout": "Leave",
        "mousedown": "ButtonPress",
        "mouseup": "ButtonRelease",
        "mousemove": "Motion"
    };

    var Server = new Class({
        initialize: function(width, height) {
            this.width = width;
            this.height = height;

            this.publicServer = new PublicServer(this);

            this._setupDOM();
            this.elem = this._container;

            this._setupInputHandlers();

            this._backgroundColor = 'rgb(51, 110, 165)';
            this._clients = [];

            this._nextWindowId = 0;
            this._windowsById = {};

            // The region of the screen that needs to be updated.
            this._damagedRegion = new Region();
            this._queueRedraw = new Task(this._redraw.bind(this));

            // This needs to be done after we set up everything else
            // as it uses the standard redraw and windowing machinery.
            this._rootWindow = this._createRootWindow();
            this._container.appendChild(this._rootWindow.inputWindow);

            this.setDebugEnabled(DEBUG);
        },

        _setupDOM: function() {
            this._container = document.createElement("div");

            // Allow querying with .xserver.js
            this._container.classList.add("xserver");
            this._container.classList.add("js");

            sizeElement(this._container, this.width, this.height);

            this._canvas = document.createElement("canvas");
            this._canvas.width = this.width;
            this._canvas.height = this.height;
            this._container.appendChild(this._canvas);

            this._ctx = this._canvas.getContext('2d');
        },

        _createRootWindow: function() {
            var rootWindow = this._createWindowInternal();
            rootWindow.changeAttributes({ backgroundColor: this._backgroundColor });
            rootWindow.parentServerWindow = null;
            this.configureRequest(rootWindow.windowId, 0, 0, this.width, this.height);
            return rootWindow;
        },

        setDebugEnabled: function(value) {
            this._debugEnabled = value;

            if (this._debugEnabled && !this._debugCanvas) {
                this._debugCanvas = document.createElement("canvas");
                this._debugCanvas.classList.add("debugCanvas");
                this._debugCanvas.width = this.width;
                this._debugCanvas.height = this.height;
                this._debugCtx = this._debugCanvas.getContext("2d");
                this._container.appendChild(this._debugCanvas);
            }

            if (this._debugEnabled) {
                this._container.classList.add("debug");
            } else {
                this._container.classList.remove("debug");
                this._debugDrawClear();
            }
        },
        toggleDebug: function() {
            this.setDebugEnabled(!this._debugEnabled);
        },
        _debugDrawRegion: function(region, style) {
            if (!this._debugEnabled)
                return;

            this._debugCtx.beginPath();
            this._debugCtx.save();
            pathFromRegion(this._debugCtx, region);
            this._debugCtx.fillStyle = style;
            this._debugCtx.globalAlpha = 0.4;
            this._debugCtx.fill();
            this._debugCtx.restore();
        },
        _debugDrawClear: function() {
            if (!this._debugEnabled)
                return;

            this._debugCtx.clearRect(0, 0, this._debugCtx.canvas.width, this._debugCtx.canvas.height);
        },

        queueFullRedraw: function() {
            var fullRegion = new Region();
            fullRegion.init_rect(0, 0, this.width, this.height);
            this.damageRegion(fullRegion);
            fullRegion.finalize();
        },

        _iterWindowsAboveWindow: function(serverWindow, callback) {
            while (serverWindow != null && serverWindow.parentServerWindow != null) {
                var parent = serverWindow.parentServerWindow;
                var idx = parent.children.indexOf(serverWindow);
                var windowsOnTop = parent.children.slice(0, idx);
                windowsOnTop.forEach(callback);
                serverWindow = parent;
            }
        },

        _subtractAboveWindowsFromRegion: function(serverWindow, region) {
            this._iterWindowsAboveWindow(serverWindow, function(aboveWindow) {
                var transformedShapeRegion = aboveWindow.calculateTransformedShapeRegion();
                region.subtract(region, transformedShapeRegion);
                transformedShapeRegion.finalize();
            });
        },

        // For a given window, return the region that would be
        // immediately damaged if the window was removed. That is,
        // the window's shape region clipped to the areas that are
        // visible.
        _calculateEffectiveRegionForWindow: function(serverWindow) {
            var region = serverWindow.calculateTransformedShapeRegion();
            this._subtractAboveWindowsFromRegion(serverWindow, region);
            return region;
        },

        _redraw: function() {
            // The damaged region is global, not per-window. This function
            // walks all windows, computing the intersection of the global
            // damage and the window region, and translates it into window-
            // local coordinates.

            var intersection = new Region();

            // This is a copy of the damage region for calculating
            // the effective damage at every step. We don't want
            // to subtract damage until the client draws and clears
            // the damage.
            var calculatedDamageRegion = new Region();
            calculatedDamageRegion.copy(this._damagedRegion);

            if (this._debugEnabled)
                this._debugDrawClear();

            this._debugDrawRegion(calculatedDamageRegion, 'red');

            function iterateWindow(serverWindow) {
                // When we iterate over children, transform the damage region into the
                // child's parent space, which is the coordinate space of the shape region.
                calculatedDamageRegion.translate(-serverWindow.x, -serverWindow.y);
                serverWindow.children.forEach(iterateWindow);
                calculatedDamageRegion.translate(serverWindow.x, serverWindow.y);

                intersection.clear();
                intersection.intersect(calculatedDamageRegion, serverWindow.shapeRegion);

                if (intersection.not_empty()) {
                    calculatedDamageRegion.subtract(calculatedDamageRegion, intersection);

                    // The damage region is in window space, so we need to translate
                    // from parent space to window space. Don't bother translating
                    // back as the intersection will just be cleared next iteration.
                    intersection.translate(-serverWindow.x, -serverWindow.y);
                    serverWindow.damage(intersection);
                }
            }

            iterateWindow(this._rootWindow);

            intersection.finalize();
            calculatedDamageRegion.finalize();

            return false;
        },
        damageRegion: function(region) {
            this._damagedRegion.union(this._damagedRegion, region);
            this._queueRedraw();
        },
        subtractDamage: function(region) {
            this._damagedRegion.subtract(this._damagedRegion, region);
            // This is expected to be called after the client has painted,
            // so don't queue a repaint.
        },
        sendEvent: function(event) {
            this._clients.forEach(function(client) {
                client.sendEvent(event);
            });
        },

        _constructInputEvent: function(domEvent, serverWindow) {
            var eventType = inputEventMap[domEvent.type];

            var rootCoords = getEventCoordsInDomElementSpace(domEvent, this._container);
            var winCoords = getEventCoordsInDomElementSpace(domEvent, serverWindow.inputWindow);

            var event = { type: eventType,
                          rootWindowId: this._rootWindow.windowId,
                          windowId: serverWindow.windowId,
                          rootX: rootCoords.x,
                          rootY: rootCoords.y,
                          winX: winCoords.x,
                          winY: winCoords.y };

            switch (eventType) {
                case "Enter":
                case "Leave":
                case "Motion":
                // nothing extra, yet
                break;
                case "ButtonPress":
                case "ButtonRelease":
                event.button = domEvent.which;
                break;
            }

            return event;
        },
        _setupInputHandlers: function() {
            // This captures all input through bubbling
            var handler = this._handleInput.bind(this);
            Object.keys(inputEventMap).forEach(function(eventName) {
                this._container.addEventListener(eventName, handler);
            }, this);
        },
        _handleInput: function(event) {
            // X does not have event bubbling, so stop
            // it now.
            event.preventDefault();
            event.stopPropagation();

            var domInputWindow = event.target;
            var serverWindow = domInputWindow._serverWindow;
            if (!serverWindow)
                return;

            var ourEvent = this._constructInputEvent(event, serverWindow);
            this.sendEvent(ourEvent);
        },

        _configureWindow: function(serverWindow, x, y, width, height) {
            // This is a bit fancy. We need to accomplish a few things:
            //
            //   1. If the area on top of the window was damaged before
            //      the reconfigure, we need to ensure we move that
            //      damaged region to the new coordinates.
            //
            //   2. If the window was resized, we need to ensure we mark
            //      the newly exposed region on the window itself as
            //      damaged.
            //
            //   3. If the window was moved, we need to ensure we mark
            //      the newly exposed region under the old position of
            //      the window as damaged.
            //
            //   4. Make sure we prevent exposing as much as possible.
            //      If a window, completely obscured, moves somewhere,
            //      we shouldn't expose any pixels. Similar sensible
            //      behavior should happen for cases the window is
            //      partially obscured.

            // 1., 2., and 3. are documented where the corresponding code is done.
            // 4. is done by making sure we call _calculateEffectiveRegionForWindow,
            //    which excludes the region where windows visually obscure the window.

            var oldRegion = this._calculateEffectiveRegionForWindow(serverWindow);
            var oldTxform = serverWindow.calculateAbsoluteOffset(true);
            var oldX = oldTxform.x, oldY = oldTxform.y;
            var oldW = serverWindow.width, oldH = serverWindow.height;

            // Reconfigure the window -- this will modify the shape region.
            serverWindow.reconfigure(x, y, width, height);

            var newRegion = this._calculateEffectiveRegionForWindow(serverWindow);
            var newTxform = serverWindow.calculateAbsoluteOffset(true);
            var newX = newTxform.x, newY = newTxform.y;

            var damagedRegion = new Region();

            // 1. (We need to do this first, as the other steps manipulate
            //     oldRegion and the global damaged region in ways that would
            //     cause us to damage more than necessary.)
            //    Pixels that were marked as damaged on the old window need
            //    to be translated to pixels on the global damaged region.
            damagedRegion.intersect(this._damagedRegion, oldRegion);
            damagedRegion.translate(newX - oldX, newY - oldY);
            this._damagedRegion.union(this._damagedRegion, damagedRegion);

            // 2. Pixels need to be exposed under the window in places where the
            //    old region is, but the new region isn't.
            damagedRegion.subtract(oldRegion, newRegion);
            this._damagedRegion.union(this._damagedRegion, damagedRegion);
            this._debugDrawRegion(damagedRegion, 'yellow');

            damagedRegion.clear();

            // If X/Y change, we copy the old area, so we need to translate into
            // the coordinate space of the new window's position to know what needs
            // to be redrawn after the copy.
            oldRegion.translate(newX - oldX, newY - oldY);

            // 3. Pixels need to be exposed on the window in places where the
            //    new region is, but the old region isn't.
            damagedRegion.subtract(newRegion, oldRegion);
            this._damagedRegion.union(this._damagedRegion, damagedRegion);
            this._debugDrawRegion(damagedRegion, 'green');

            // Copy the old image contents over, masked to the region.
            var ctx = this._ctx;
            ctx.beginPath();
            ctx.save();
            pathFromRegion(ctx, newRegion);
            ctx.clip();
            ctx.drawImage(ctx.canvas, oldX, oldY, oldW, oldH, newX, newY, oldW, oldH);
            ctx.restore();
            this._queueRedraw();

            oldRegion.finalize();
            newRegion.finalize();
            damagedRegion.finalize();
        },

        // Used by _createRootWindow and createWindow.
        _createWindowInternal: function() {
            var windowId = ++this._nextWindowId;
            var serverWindow = new ServerWindow(windowId, this, this._ctx);
            this._windowsById[windowId] = serverWindow;
            return serverWindow;
        },
        _damageWindow: function(serverWindow) {
            var region = this._calculateEffectiveRegionForWindow(serverWindow);
            this.damageRegion(region);
            region.finalize();
        },
        _unparentWindow: function(serverWindow) {
            // Damage the region that will be exposed when the
            // window is destroyed.
            this._damageWindow(serverWindow);

            var parentServerWindow = serverWindow.parentServerWindow;
            parentServerWindow.inputWindow.removeChild(serverWindow.inputWindow);
            parentServerWindow.children.erase(serverWindow);
        },
        _parentWindow: function(serverWindow, parentServerWindow) {
            serverWindow.parentServerWindow = parentServerWindow;
            parentServerWindow.children.unshift(serverWindow);
            parentServerWindow.inputWindow.appendChild(serverWindow.inputWindow);
            this._damageWindow(serverWindow);
        },

        //
        // Public API for clients.
        //
        clientConnected: function(client) {
            var serverClient = new ServerClient(this, client);
            client._serverClient = serverClient;
            this._clients.push(serverClient);
        },
        selectInput: function(client, windowId, eventTypes) {
            var serverClient = client._serverClient;
            serverClient.selectInput(windowId, eventTypes);
        },
        createWindow: function() {
            var serverWindow = this._createWindowInternal();
            this._parentWindow(serverWindow, this._rootWindow);
            return serverWindow.windowId;
        },
        destroyWindow: function(windowId) {
            var serverWindow = this._windowsById[windowId];
            this._unparentWindow(serverWindow);
            serverWindow.finalize();
            this._windowsById[windowId] = null;
        },
        reparentWindow: function(windowId, newParentId) {
            var serverWindow = this._windowsById[windowId];
            var newServerParentWindow = this._windowsById[newParentId];
            this._unparentWindow(serverWindow);
            this._parentWindow(serverWindow, newServerParentWindow);
        },
        raiseWindow: function(windowId) {
            var serverWindow = this._windowsById[windowId];
            var parentServerWindow = serverWindow.parentServerWindow;
            parentServerWindow.children.erase(serverWindow);
            parentServerWindow.children.unshift(serverWindow);
            parentServerWindow.inputWindow.removeChild(serverWindow.inputWindow);
            parentServerWindow.inputWindow.appendChild(serverWindow.inputWindow);
            this._damageWindow(serverWindow);
        },
        lowerWindow: function(windowId) {
            var serverWindow = this._windowsById[windowId];

            // Damage the region that will be exposed when the
            // window is lowered to the bottom.
            this._damageWindow(serverWindow);

            var parentServerWindow = serverWindow.parentServerWindow;
            parentServerWindow.children.erase(serverWindow);
            parentServerWindow.children.push(serverWindow);
            parentServerWindow.inputWindow.removeChild(serverWindow.inputWindow);
            parentServerWindow.inputWindow.insertBefore(serverWindow.inputWindow, parentServerWindow.inputWindow.firstChild);
        },
        configureRequest: function(windowId, x, y, width, height) {
            var serverWindow = this._windowsById[windowId];
            this._configureWindow(serverWindow, x, y, width, height);
        },
        changeAttributes: function(windowId, attributes) {
            var serverWindow = this._windowsById[windowId];
            serverWindow.changeAttributes(attributes);
        },
        changeProperty: function(windowId, name, value) {
            var serverWindow = this._windowsById[windowId];
            serverWindow.changeProperty(name, value);
        },
        defineCursor: function(windowId, cursor) {
            var serverWindow = this._windowsById[windowId];
            serverWindow.defineCursor(cursor);
        },
        invalidateWindow: function(windowId) {
            var serverWindow = this._windowsById[windowId];
            this._damageWindow(serverWindow);
        },
    });

    exports.Server = Server;

})(window);
