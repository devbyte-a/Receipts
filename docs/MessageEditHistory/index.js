(function(exports, plugin, metro, common, patcher, assets, toasts, utils, vendetta, ui, storage) {
    "use strict";

    const STORAGE_KEY = "messageEditHistory";
    const MAX_HISTORIES = 200;
    const EXPIRATION_MS = 12 * 60 * 60 * 1000;
    const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
    const messageCache = new Map();
    const listeners = new Set();
    let cleanupTimer;
    let dispatcher;
    let loaded = false;
    const debugState = {
        loaded: false,
        rendererDiscoverySucceeded: false,
        candidates: [],
        selectedRenderer: null,
        patchInstalled: false,
        patchThrows: 0,
        historyCount: 0,
        errors: [],
        nextObservation: "No safe row-level interaction hook is exposed by the verified runtime. The plugin cannot capture mounted props without a verified component callback.",
        interactionStatus: "unavailable: FluxDispatcher provides message events only; no supported mounted-message interaction callback or safe row-renderer reference is available.",
        lastInteraction: null,
        actionSheetInvestigation: {
            status: "not-run",
            candidateNames: [],
            candidatePropKeys: [],
            messageEvidence: false
        },
        actionSheetInvocation: {
            called: false,
            argumentCount: 0,
            arguments: []
        }
    };
    let actionSheetLoader;
    let originalOpenLazy;
    let wrappedOpenLazy;

    function log(message, error) {
        if (error) console.error("[Message Edit History] " + message, error);
        else console.log("[Message Edit History] " + message);
        if (error) debugState.errors.push(String(message));
    }

    function notify() {
        debugState.historyCount = messageCache.size;
        listeners.forEach(function(listener) {
            try { listener(); } catch (error) { log("History listener failed", error); }
        });
    }

    function subscribe(listener) {
        if (typeof listener !== "function") return function() {};
        listeners.add(listener);
        return function() { listeners.delete(listener); };
    }

    function messageFields(message) {
        if (!message || message.id == null) return null;
        const author = message.author || {};
        return {
            messageId: String(message.id),
            channelId: message.channel_id == null ? "" : String(message.channel_id),
            authorId: author.id == null ? "" : String(author.id),
            authorName: author.username == null ? "" : String(author.username),
            content: message.content == null ? "" : String(message.content),
            timestamp: message.timestamp || message.edited_timestamp || new Date().toISOString()
        };
    }

    function persist() {
        if (!storage || typeof storage !== "object") return;
        const histories = [];
        messageCache.forEach(function(entry) {
            if (entry.versions.length > 1 && entry.expiresAt > Date.now()) histories.push(entry);
        });
        histories.sort(function(left, right) { return right.expiresAt - left.expiresAt; });
        try { storage[STORAGE_KEY] = JSON.stringify(histories.slice(0, MAX_HISTORIES)); }
        catch (error) { log("Could not persist histories", error); }
    }

    function cleanupExpired() {
        const now = Date.now();
        let changed = false;
        messageCache.forEach(function(entry, id) {
            if (entry.expiresAt && entry.expiresAt <= now) {
                messageCache.delete(id);
                changed = true;
            }
        });
        if (changed || loaded) {
            persist();
            if (changed) notify();
        }
    }

    function loadPersisted() {
        if (!storage || typeof storage !== "object") return;
        try {
            const raw = storage[STORAGE_KEY];
            const histories = typeof raw === "string" ? JSON.parse(raw) : raw;
            if (!Array.isArray(histories)) return;
            histories.forEach(function(entry) {
                if (!entry || entry.messageId == null || !Array.isArray(entry.versions)) return;
                if (entry.versions.length < 2 || !entry.expiresAt || entry.expiresAt <= Date.now()) return;
                messageCache.set(String(entry.messageId), entry);
            });
        } catch (error) { log("Could not load persisted histories", error); }
    }

    function recordMessageCreate(message) {
        const fields = messageFields(message);
        if (!fields || messageCache.has(fields.messageId)) return;
        messageCache.set(fields.messageId, {
            messageId: fields.messageId,
            channelId: fields.channelId,
            authorId: fields.authorId,
            authorName: fields.authorName,
            versions: [{ content: fields.content, timestamp: fields.timestamp }],
            currentContent: fields.content,
            editedAt: null,
            expiresAt: null
        });
    }

    function recordMessageUpdate(message) {
        const fields = messageFields(message);
        if (!fields) return;
        const entry = messageCache.get(fields.messageId);
        if (!entry || entry.currentContent === fields.content) return;
        const editedAt = message.edited_timestamp || new Date().toISOString();
        entry.versions.push({ content: fields.content, timestamp: editedAt });
        entry.currentContent = fields.content;
        entry.editedAt = editedAt;
        entry.expiresAt = new Date(editedAt).getTime() + EXPIRATION_MS;
        persist();
        notify();
    }

    function getHistory(messageId, channelId) {
        const entry = messageCache.get(String(messageId));
        if (!entry || (channelId != null && String(channelId) !== entry.channelId)) return null;
        if (entry.expiresAt && entry.expiresAt <= Date.now()) {
            messageCache.delete(String(messageId));
            persist();
            return null;
        }
        return entry;
    }

    function componentShape(value) {
        return typeof value === "function" || !!(value && typeof value === "object" && (typeof value.render === "function" || typeof value.type === "function"));
    }

    function scoreProps(props) {
        if (!props || typeof props !== "object") return 0;
        const keys = ["message", "messageId", "channelId", "author", "content", "id", "children"];
        return keys.reduce(function(score, key) { return score + (Object.prototype.hasOwnProperty.call(props, key) ? 1 : 0); }, 0);
    }

    function addCandidate(label, value, props) {
        const score = scoreProps(props || value);
        if (!componentShape(value) && score === 0) return;
        debugState.candidates.push({
            label: String(label || "unknown"),
            displayName: value && value.displayName ? String(value.displayName) : null,
            hasRender: !!(value && typeof value.render === "function"),
            propKeys: props && typeof props === "object" ? Object.keys(props).slice(0, 30) : [],
            score: score
        });
    }

    function inspectProps(props, label) {
        try {
            const message = props && props.message;
            const hasSingleMessage = !!(message && typeof message === "object" && message.id != null && (message.channel_id != null || props.channelId != null || props.channel_id != null));
            const candidateLabel = label || "runtime props";
            addCandidate(candidateLabel, null, props);
            if (hasSingleMessage) {
                debugState.selectedRenderer = {
                    label: candidateLabel,
                    propKeys: Object.keys(props).slice(0, 30),
                    messageKeys: Object.keys(message).slice(0, 30),
                    messageIdPresent: true,
                    channelIdPresent: message.channel_id != null || props.channelId != null || props.channel_id != null,
                    individualMessageEvidence: true
                };
                debugState.lastInteraction = {
                    componentName: candidateLabel,
                    propKeys: Object.keys(props).slice(0, 30),
                    hasMessage: true,
                    messageIdPresent: true,
                    channelIdPresent: message.channel_id != null || props.channelId != null || props.channel_id != null
                };
                debugState.nextObservation = "A single-message prop shape was observed. Record the component object and callable render method from the same interaction, then verify patcher signature before patching.";
            }
            debugState.candidates.sort(function(left, right) { return right.score - left.score; });
            debugState.candidates = debugState.candidates.slice(0, 100);
            exposeDebug();
            return debugState.candidates[0] || null;
        } catch (error) {
            log("Runtime prop inspection failed", error);
            return null;
        }
    }

    function inspectMountedMessage(props, label) {
        return inspectProps(props, label || "mounted message props");
    }

    function getLastInteraction() {
        return debugState.lastInteraction;
    }

    function discoverRenderer() {
        try {
            debugState.candidates = [];
            const candidates = metro && typeof metro.findAll === "function" ? metro.findAll(function(module) {
                return module && module.displayName === "MessagesConnected";
            }) : [];
            (Array.isArray(candidates) ? candidates : []).forEach(function(module, index) {
                addCandidate("MessagesConnected[" + index + "]", module, module && module.props);
            });
            debugState.candidates.sort(function(left, right) { return right.score - left.score; });
            debugState.candidates = debugState.candidates.slice(0, 100);
            debugState.rendererDiscoverySucceeded = true;
            exposeDebug();
            log("Renderer discovery found " + debugState.candidates.length + " known container candidate(s); no component patched.");
        } catch (error) {
            debugState.rendererDiscoverySucceeded = false;
            exposeDebug();
            log("Renderer discovery failed; continuing without UI patch", error);
        }
    }

    function investigateActionSheet() {
        try {
            const loader = metro && typeof metro.findByProps === "function" ? metro.findByProps("openLazy") : null;
            if (!loader || typeof loader !== "object") {
                debugState.actionSheetInvestigation = {
                    status: "unavailable: findByProps(\"openLazy\") returned no object",
                    candidateNames: [],
                    candidatePropKeys: [],
                    messageEvidence: false
                };
                exposeDebug();
                return;
            }
            const candidateNames = Object.keys(loader);
            const candidatePropKeys = candidateNames.filter(function(name) {
                return name !== "openLazy" && name !== "hideActionSheet" && name !== "hideAllActionSheets" && name !== "setActionSheetZIndex" && name !== "resetActionSheetsForAppEntryKey";
            });
            debugState.actionSheetInvestigation = {
                status: "inspected: loader exports only; openLazy was not invoked",
                candidateNames: candidateNames,
                candidatePropKeys: candidatePropKeys,
                messageEvidence: candidatePropKeys.some(function(name) {
                    return /message|channel|author|content|row/i.test(name);
                })
            };
            exposeDebug();
            log("Action-sheet loader inspected without invocation; no message component selected.");
        } catch (error) {
            debugState.actionSheetInvestigation = {
                status: "failed: safe loader inspection threw",
                candidateNames: [],
                candidatePropKeys: [],
                messageEvidence: false
            };
            exposeDebug();
            log("Action-sheet investigation failed; continuing without patch", error);
        }
    }

    function inspectInvocationArgument(argument) {
        const type = argument === null ? "null" : typeof argument;
        const isObject = argument !== null && (type === "object" || type === "function");
        const keys = isObject ? Object.keys(argument).slice(0, 30) : [];
        const message = argument && typeof argument === "object" && argument.message && typeof argument.message === "object" ? argument.message : null;
        const messageIdPresent = !!(message && message.id != null) || !!(argument && typeof argument === "object" && argument.messageId != null);
        const channelIdPresent = !!(message && message.channel_id != null) || !!(argument && typeof argument === "object" && (argument.channelId != null || argument.channel_id != null));
        return {
            type: type,
            keys: keys,
            messageIdPresent: messageIdPresent,
            channelIdPresent: channelIdPresent,
            componentLike: type === "function" || !!(argument && typeof argument === "object" && (typeof argument.render === "function" || typeof argument.type === "function")),
            functionKeys: type === "function" ? Object.keys(argument).slice(0, 20) : []
        };
    }

    function installActionSheetWrapper() {
        try {
            actionSheetLoader = metro && typeof metro.findByProps === "function" ? metro.findByProps("openLazy") : null;
            originalOpenLazy = actionSheetLoader && actionSheetLoader.openLazy;
            if (!actionSheetLoader || typeof originalOpenLazy !== "function") {
                debugState.actionSheetInvestigation.status = "unavailable: openLazy is not a callable function";
                exposeDebug();
                return;
            }
            wrappedOpenLazy = function() {
                try {
                    debugState.actionSheetInvocation = {
                        called: true,
                        argumentCount: arguments.length,
                        arguments: Array.prototype.slice.call(arguments).map(inspectInvocationArgument)
                    };
                    exposeDebug();
                } catch (error) { log("Could not inspect openLazy invocation", error); }
                return originalOpenLazy.apply(this, arguments);
            };
            actionSheetLoader.openLazy = wrappedOpenLazy;
            debugState.actionSheetInvestigation.status = "wrapped: waiting for Discord to invoke openLazy; arguments are forwarded unchanged";
            exposeDebug();
        } catch (error) {
            debugState.actionSheetInvestigation.status = "failed: openLazy could not be wrapped safely";
            exposeDebug();
            log("Action-sheet wrapper installation failed", error);
        }
    }

    function removeActionSheetWrapper() {
        try {
            if (actionSheetLoader && actionSheetLoader.openLazy === wrappedOpenLazy) actionSheetLoader.openLazy = originalOpenLazy;
        } catch (error) { log("Could not restore openLazy", error); }
        actionSheetLoader = undefined;
        originalOpenLazy = undefined;
        wrappedOpenLazy = undefined;
    }

    function exposeDebug() {
        debugState.historyCount = messageCache.size;
        try {
            if (typeof globalThis !== "undefined") {
                globalThis.__MessageEditHistoryDebug = {
                    loaded: debugState.loaded,
                    rendererDiscoverySucceeded: debugState.rendererDiscoverySucceeded,
                    candidates: debugState.candidates.slice(),
                    selectedRenderer: debugState.selectedRenderer,
                    patchInstalled: debugState.patchInstalled,
                    patchThrows: debugState.patchThrows,
                    historyCount: debugState.historyCount,
                    errors: debugState.errors.slice(),
                    nextObservation: debugState.nextObservation,
                    interactionStatus: debugState.interactionStatus,
                    actionSheetInvestigation: {
                        status: debugState.actionSheetInvestigation.status,
                        candidateNames: debugState.actionSheetInvestigation.candidateNames.slice(),
                        candidatePropKeys: debugState.actionSheetInvestigation.candidatePropKeys.slice(),
                        messageEvidence: debugState.actionSheetInvestigation.messageEvidence
                    },
                    actionSheetInvocation: {
                        called: debugState.actionSheetInvocation.called,
                        argumentCount: debugState.actionSheetInvocation.argumentCount,
                        arguments: debugState.actionSheetInvocation.arguments.slice()
                    },
                    getLastInteraction: getLastInteraction,
                    inspectProps: inspectProps,
                    inspectMountedMessage: inspectMountedMessage
                };
            }
        } catch (error) { log("Could not expose debug state", error); }
    }

    function onMessageCreate(event) { recordMessageCreate(event && event.message); }
    function onMessageUpdate(event) { recordMessageUpdate(event && event.message); }

    function onLoad() {
        if (loaded) return;
        loaded = true;
        debugState.loaded = true;
        exposeDebug();
        loadPersisted();
        cleanupExpired();
        try {
            dispatcher = metro && metro.common && metro.common.FluxDispatcher;
            if (!dispatcher || typeof dispatcher.subscribe !== "function") {
                log("FluxDispatcher unavailable; history tracking is disabled");
            } else {
                dispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
                dispatcher.subscribe("MESSAGE_UPDATE", onMessageUpdate);
            }
        } catch (error) { log("Could not subscribe to message events", error); }
        cleanupTimer = setInterval(cleanupExpired, CLEANUP_INTERVAL_MS);
        discoverRenderer();
        investigateActionSheet();
        installActionSheetWrapper();
    }

    function onUnload() {
        removeActionSheetWrapper();
        try {
            if (dispatcher && typeof dispatcher.unsubscribe === "function") {
                dispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
                dispatcher.unsubscribe("MESSAGE_UPDATE", onMessageUpdate);
            }
        } catch (error) { log("Could not unsubscribe from message events", error); }
        if (cleanupTimer) clearInterval(cleanupTimer);
        cleanupTimer = undefined;
        dispatcher = undefined;
        listeners.clear();
        messageCache.clear();
        loaded = false;
        debugState.loaded = false;
        debugState.historyCount = 0;
        debugState.patchInstalled = false;
        debugState.lastInteraction = null;
        debugState.actionSheetInvestigation = {
            status: "not-run",
            candidateNames: [],
            candidatePropKeys: [],
            messageEvidence: false
        };
        debugState.actionSheetInvocation = {
            called: false,
            argumentCount: 0,
            arguments: []
        };
        try {
            if (typeof globalThis !== "undefined") delete globalThis.__MessageEditHistoryDebug;
        } catch (error) { log("Could not reset debug state", error); }
    }

    const Settings = function() { return null; };
    exports.default = { onLoad: onLoad, onUnload: onUnload, settings: Settings };
    exports.history = {
        recordMessageCreate: recordMessageCreate,
        recordMessageUpdate: recordMessageUpdate,
        getHistory: getHistory,
        cleanupExpired: cleanupExpired,
        subscribe: subscribe
    };
    return exports;
})({}, vendetta.plugin, vendetta.metro, vendetta.metro.common, vendetta.patcher, vendetta.ui.assets, vendetta.ui.toasts, vendetta.utils, vendetta, vendetta.ui, vendetta.storage);