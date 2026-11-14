/* MiniDOM v0.0.132 — small, chainable DOM helper. No dependencies. */
(function (global) {
    'use strict';

    const VERSION = '0.0.132';
    const previousDollar = global.$;
    const displayMemory = new WeakMap();
    const eventMemory = new WeakMap();
    const dataMemory = new WeakMap();
    const resizeMemory = new WeakMap();
    let sharedResizeObserver = null;
    const mutationMemory = new WeakMap();
    const fadeMemory = new WeakMap();


    function isNode(value) {
        return value != null && typeof value.nodeType === 'number';
    }

    // One pass: remove duplicates while keeping the first-seen order.
    function unique(items) {
        // Most chained operations produce zero or one node. Avoid allocating a
        // Set in that common case, but retain full deduplication otherwise.
        if (items.length === 0) return [];
        if (items.length === 1) {
            const only = items[0];
            return only == null ? [] : [only];
        }
        // Native NodeLists never contain the same DOM node twice; copy them
        // directly rather than allocate a Set for every CSS selection.
        if (global.NodeList && items instanceof global.NodeList) return Array.from(items);
        const result = [];
        const seen = new Set();
        for (const item of items) {
            if (item == null || seen.has(item)) continue;
            seen.add(item);
            result.push(item);
        }
        return result;
    }

    function nodes(value) {
        if (value instanceof Collection) return value.elements;
        if (isNode(value) || value === global) return [value];
        if (value != null && typeof value !== 'string' &&
            typeof value[Symbol.iterator] === 'function') {
            return [...value].filter(item => isNode(item) || item === global);
        }
        return [];
    }

    function select(value, context) {
        // TrustedHTML is an object, not a string. Preserve its brand when
        // creating elements, including under an enforced Trusted Types CSP.
        const trusted = Boolean(global.TrustedHTML && value instanceof global.TrustedHTML);
        if (typeof value !== 'string' && !trusted) return nodes(value);

        // jQuery-style element creation. Only markup-shaped strings are parsed;
        // ordinary strings remain CSS selectors. Do NOT interpolate untrusted
        // data into HTML strings: use .text() / .val() for user input.
        const trimmed = trusted ? String(value).trim() : value.trim();
        if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
            const template = global.document.createElement('template');
            template.innerHTML = trusted ? value : trimmed;
            const created = [...template.content.childNodes];
            for (const node of created) template.content.removeChild(node);
            return created;
        }

        const roots = context === undefined ? [global.document] :
            typeof context === 'string' ? select(context) : nodes(context);
        return queryExtended(trimmed, roots);
    }

    // Split a selector only at top-level commas/combinators. Native CSS stays
    // in querySelectorAll; MiniDOM extensions are filtered at each path step.
    function splitSelector(input, splitCommas = false) {
        const result = []; let buffer = '', quote = '', bracket = 0, paren = 0;
        for (let i = 0; i < input.length; i++) {
            const ch = input[i];
            if (quote) {
                buffer += ch;
                if (ch === '\\' && i + 1 < input.length) buffer += input[++i];
                else if (ch === quote) quote = '';
                continue;
            }
            if (ch === '\\' && i + 1 < input.length) { buffer += ch + input[++i]; continue; }
            if (ch === '"' || ch === "'") { quote = ch; buffer += ch; continue; }
            if (ch === '[') bracket++;
            if (ch === ']') bracket--;
            if (ch === '(') paren++;
            if (ch === ')') paren--;
            if (!bracket && !paren && (splitCommas ? ch === ',' : /[>+~\s]/.test(ch))) {
                if (buffer.trim()) result.push(buffer.trim());
                buffer = '';
                if (!splitCommas && /[>+~]/.test(ch)) result.push(ch);
                else if (!splitCommas && !/\s/.test(result[result.length - 1] || '')) {
                    if (result[result.length - 1] !== ' ' && !/[>+~]/.test(result[result.length - 1] || '')) result.push(' ');
                }
                continue;
            }
            buffer += ch;
        }
        if (buffer.trim()) result.push(buffer.trim());
        if (!splitCommas && result[result.length - 1] === ' ') result.pop();
        return result;
    }

    const customPseudo = /:(visible|hidden|input|contains\((?:[^()]|\([^()]*\))*\)|first(?!-)|last(?!-)|eq\(-?\d+\)|lt\(-?\d+\)|gt\(-?\d+\)|even|odd|header|parent|selected|checkbox|radio|button|text|file|password|submit|reset|animated)(?![\w-])/g;

    function pseudoParts(part) {
        const tests = [];
        // Do not strip pseudo-like text inside CSS attribute values.
        let css = '', quote = '', bracket = 0, paren = 0;
        for (let i = 0; i < part.length;) {
            const ch = part[i];
            if (quote) {
                css += ch;
                if (ch === '\\' && i + 1 < part.length) css += part[++i];
                else if (ch === quote) quote = '';
                i++; continue;
            }
            if (ch === '\\' && i + 1 < part.length) { css += ch + part[i + 1]; i += 2; continue; }
            if (ch === '"' || ch === "'") { quote = ch; css += ch; i++; continue; }
            if (ch === '[') bracket++;
            if (ch === ']') bracket--;
            if (ch === '(') paren++;
            if (ch === ')') paren--;
            if (!bracket && !paren && part.startsWith(':not(', i)) {
                // Support negation of a single MiniDOM pseudo without passing
                // nonstandard selectors to the browser's CSS parser.
                const start = i + 5;
                let depth = 1, end = start, nestedQuote = '';
                for (; end < part.length && depth; end++) {
                    const c = part[end];
                    if (nestedQuote) {
                        if (c === '\\') { end++; continue; }
                        if (c === nestedQuote) nestedQuote = '';
                    } else if (c === '\"' || c === "'") nestedQuote = c;
                    else if (c === '\\') end++;
                    else if (c === '(') depth++;
                    else if (c === ')') depth--;
                }
                if (depth === 0) {
                    const inner = part.slice(start, end - 1).trim();
                    customPseudo.lastIndex = 0;
                    const nested = customPseudo.exec(inner);
                    if (nested && nested.index === 0 && nested[0].length === inner.length) {
                        tests.push({ negate: nested[1] });
                        i = end; continue;
                    }
                }
            }
            if (!bracket && !paren && ch === ':') {
                customPseudo.lastIndex = i;
                const match = customPseudo.exec(part);
                if (match && match.index === i) {
                    tests.push(match[1]); i = customPseudo.lastIndex; continue;
                }
            }
            css += ch; i++;
        }
        return { css: css.trim() || '*', tests };
    }

    function applyPseudo(elements, test) {
        if (typeof test === 'object' && test.negate) {
            // Positional pseudos apply to the current result set, not each
            // element independently (where :first would match every element).
            const positional = /^(?:first|last|even|odd|eq\(-?\d+\)|lt\(-?\d+\)|gt\(-?\d+\))$/.test(test.negate);
            if (positional) {
                const excluded = new Set(applyPseudo(elements, test.negate));
                return elements.filter(element => !excluded.has(element));
            }
            return elements.filter(element => !selectorMatch(element, ':' + test.negate));
        }
        const n = elements.length;
        if (test === 'first') return elements.slice(0, 1);
        if (test === 'last') return elements.slice(-1);
        if (test === 'even') return elements.filter((_, i) => i % 2 === 0);
        if (test === 'odd') return elements.filter((_, i) => i % 2 === 1);
        const positional = /^(eq|lt|gt)\((-?\d+)\)$/.exec(test);
        if (positional) {
            let index = Number(positional[2]); if (index < 0) index += n;
            return elements.filter((_, i) => positional[1] === 'eq' ? i === index :
                positional[1] === 'lt' ? i < index : i > index);
        }
        return elements.filter(element => selectorMatch(element, ':' + test));
    }

    // Cache only the expensive extended-selector parsing. A bounded Map avoids
    // unbounded memory growth when selectors contain dynamic values.
    const selectorPlanCache = new Map();
    const SELECTOR_PLAN_LIMIT = 128;
    function selectorPlan(selector) {
        let plan = selectorPlanCache.get(selector);
        if (plan) return plan;
        plan = splitSelector(selector, true).map(group => splitSelector(group).map(token => {
            if (/^[>+~ ]$/.test(token)) return { combinator: token };
            const { css, tests } = pseudoParts(token);
            const notEqual = [];
            const nativeCSS = css.replace(/\[([\w:-]+)\s*!=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\]/g,
                (_, name, double, single, bare) => {
                    notEqual.push([name, double ?? single ?? bare]); return '';
                }) || '*';
            return { nativeCSS, tests, notEqual };
        }));
        if (selectorPlanCache.size >= SELECTOR_PLAN_LIMIT)
            selectorPlanCache.delete(selectorPlanCache.keys().next().value);
        selectorPlanCache.set(selector, plan);
        return plan;
    }

    function queryExtended(selector, roots) {
        // Fast path: avoid parsing and intermediate arrays for ordinary CSS.
        // Reset regex state explicitly because the pseudo detector is global.
        customPseudo.lastIndex = 0;
        // Most selectors have no MiniDOM-only syntax. Avoid tokenizing them.
        // The complete parser is still used for candidates, so quoted text
        // and escaped pseudo-like fragments retain their native CSS meaning.
        const possibleExtension = /:(?:visible|hidden|input|contains|first|last|eq|lt|gt|even|odd|header|parent|selected|checkbox|radio|button|text|file|password|submit|reset|animated)(?![\w-])|\[[\w:-]+\s*!=/.test(selector);
        const extended = possibleExtension && (
            /\[[\w:-]+\s*!=/.test(selector) ||
            splitSelector(selector, true).some(group => splitSelector(group).some(token =>
                !/^[>+~ ]$/.test(token) && pseudoParts(token).tests.length > 0)));
        if (!extended) {
            if (roots.length === 1) {
                const root = roots[0];
                return root?.querySelectorAll ? Array.from(root.querySelectorAll(selector)) : [];
            }
            const found = [];
            for (const root of roots) if (root?.querySelectorAll)
                for (const element of root.querySelectorAll(selector)) found.push(element);
            return unique(found);
        }
        const all = [];
        for (const tokens of selectorPlan(selector)) {
            let current = roots, combinator = ' ';
            for (const token of tokens) {
                if (token.combinator) { combinator = token.combinator; continue; }
                const { nativeCSS, tests, notEqual } = token;
                const found = [];
                for (const root of current) {
                    if (!root) continue;
                    if (combinator === ' ') {
                        if (root.querySelectorAll) for (const match of root.querySelectorAll(nativeCSS)) found.push(match);
                    } else if (combinator === '>') {
                        for (const child of root.children || []) if (child.matches(nativeCSS)) found.push(child);
                    } else if (combinator === '+') {
                        const next = root.nextElementSibling;
                        if (next?.matches(nativeCSS)) found.push(next);
                    } else if (combinator === '~') {
                        let next = root.nextElementSibling;
                        while (next) { if (next.matches(nativeCSS)) found.push(next); next = next.nextElementSibling; }
                    }
                }
                current = unique(found).filter(el => notEqual.every(([name, value]) =>
                    el.getAttribute?.(name) !== value));
                for (const test of tests) current = applyPseudo(current, test);
                combinator = ' ';
            }
            for (const match of current) all.push(match);
        }
        return unique(all);
    }

    function classes(value) {
        return String(value).trim().split(/\s+/).filter(Boolean);
    }

    // DOMTokenList.add/remove are variadic. Passing very large token lists
    // with spread can exceed the engine's argument limit. Use bounded batches.
    function updateClassTokens(classList, tokens, operation) {
        const batchSize = 256;
        for (let start = 0; start < tokens.length; start += batchSize) {
            const batch = tokens.slice(start, start + batchSize);
            classList[operation](...batch);
        }
    }

    function cssName(name) {
        if (name.startsWith('--')) return name;
        return name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
    }

    function splitEvents(events) {
        return String(events).trim().split(/\s+/).filter(Boolean);
    }

    // DOM-ready callbacks are also supported when this file is loaded after
    // DOMContentLoaded. The ready callback receives the MiniDOM function.
    function ready(callback) {
        if (typeof callback !== 'function') throw new TypeError('ready() requires a callback');
        const run = () => callback.call(global.document, MiniDOM);
        if (global.document.readyState === 'loading') {
            global.document.addEventListener('DOMContentLoaded', run, { once: true });
        } else {
            // Keep ready callbacks asynchronous when the DOM is already ready.
            global.queueMicrotask(run);
        }
    }

    // Native form control values with jQuery-style multiple-select support.
    // Non-form nodes return undefined; file input assignment is governed by
    // native browser security restrictions.
    function readValue(element) {
        if (!element || !('value' in element)) return undefined;
        if (global.HTMLSelectElement && element instanceof global.HTMLSelectElement && element.multiple) {
            return Array.from(element.selectedOptions, option => option.value);
        }
        return element.value;
    }

    function writeValue(element, value) {
        if (!element || !('value' in element)) return;
        if (Array.isArray(value)) {
            const values = new Set(value.map(item => item == null ? '' : String(item)));
            if (global.HTMLSelectElement && element instanceof global.HTMLSelectElement) {
                for (const option of element.options) option.selected = values.has(option.value);
                return;
            }
            if (element.matches?.('input[type="checkbox"], input[type="radio"]')) {
                element.checked = values.has(element.value);
                return;
            }
            element.value = value.map(item => item == null ? '' : String(item)).join(',');
            return;
        }
        element.value = value == null ? '' : String(value);
    }

    function dataKey(key) {
        return String(key).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    }

    function dataAttr(key) {
        return 'data-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
    }

    function parseData(value) {
        if (value === 'true') return true;
        if (value === 'false') return false;
        if (value === 'null') return null;
        if (value !== '' && String(Number(value)) === value) return Number(value);
        if (/^[\[{]/.test(value)) {
            try { return JSON.parse(value); } catch (_) { /* leave string unchanged */ }
        }
        return value;
    }

    function cachedData(element) {
        let cache = dataMemory.get(element);
        if (!cache) {
            cache = Object.create(null);
            dataMemory.set(element, cache);
        }
        return cache;
    }

    function readData(element, key) {
        // WeakMap keys must be objects. Public collections can be assembled
        // manually and may contain primitives.
        if (element == null || (typeof element !== 'object' && typeof element !== 'function')) return undefined;
        // A read miss must not allocate a cache entry. This matters for
        // large read-only traversals and for arbitrary object-backed data.
        const normalized = dataKey(key);
        const cache = dataMemory.get(element);
        if (cache && Object.hasOwn(cache, normalized)) return cache[normalized];
        if (typeof element.getAttribute !== 'function') return undefined;
        const attr = element.getAttribute(dataAttr(normalized));
        if (attr === null) return undefined;
        const parsed = parseData(attr);
        cachedData(element)[normalized] = parsed;
        return parsed;
    }

    function unbindRecord(element, record) {
        // Custom EventTargets and patched native methods can throw while
        // removing a listener. Never retain our bookkeeping or abort hook
        // because a foreign implementation failed during teardown.
        try { element.removeEventListener(record.type, record.wrapped, record.options); }
        catch (_) { /* best-effort native teardown */ }
        if (record.signal && record.abortHandler) {
            try { record.signal.removeEventListener('abort', record.abortHandler); }
            catch (_) { /* best-effort abort-hook teardown */ }
        }
        const records = eventMemory.get(element);
        if (!records) return;
        const index = records.indexOf(record);
        if (index !== -1) records.splice(index, 1);
        if (!records.length) eventMemory.delete(element);
    }

    function eventTokens(events) {
        return splitEvents(events).map(token => {
            const parts = token.split('.');
            const type = parts.shift();
            const namespaces = [...new Set(parts.filter(Boolean))].sort();
            if (!type && !namespaces.length) throw new TypeError('Invalid event name');
            return { type, namespaces };
        });
    }

    function matchesToken(record, token) {
        return (!token.type || record.type === token.type) &&
            token.namespaces.every(name => record.namespaces.includes(name));
    }

    function bindEvents(collection, events, selector, handler, options, once) {
        if (typeof selector === 'function') {
            options = handler;
            handler = selector;
            selector = null;
        }
        if (typeof handler !== 'function') throw new TypeError('Event handler must be a function');
        if (selector == null) selector = null;
        if (selector !== null && typeof selector !== 'string') {
            throw new TypeError('Delegation selector must be a CSS selector string');
        }
        const tokens = eventTokens(events);
        if (tokens.some(token => !token.type)) throw new TypeError('Binding requires an event type');
        const signal = options && typeof options === 'object' ? options.signal : null;
        const removeOnce = once || Boolean(options && typeof options === 'object' && options.once);
        const nativeOptions = options && typeof options === 'object'
            ? { ...options, once: false } : options;
        const requestedCapture = typeof nativeOptions === 'boolean'
            ? nativeOptions : Boolean(nativeOptions?.capture);
        const eventData = options && typeof options === 'object' ? options.data : undefined;

        return collection.each((i, element) => {
            if (!element?.addEventListener || signal?.aborted) return;
            for (const token of tokens) {
                // Capture is per event type: a mixed 'focus click' registration
                // must not accidentally put click listeners in capture mode.
                const capture = requestedCapture || (selector !== null &&
                    (token.type === 'focus' || token.type === 'blur'));
                const records = eventMemory.get(element) || [];
                // The same callback, selector, type, namespaces and capture mode
                // is registered only once on an element.
                if (records.some(record =>
                    record.type === token.type && record.handler === handler &&
                    record.selector === selector && record.capture === capture &&
                    record.namespaces.join('.') === token.namespaces.join('.') &&
                    record.eventData === eventData && record.once === removeOnce &&
                    record.signal === signal)) continue;
                const record = {
                    type: token.type, namespaces: token.namespaces, selector, handler,
                    options: nativeOptions, capture, once: removeOnce,
                    wrapped: null, signal, abortHandler: null, eventData
                };
                record.wrapped = function (event) {
                    let context = element;
                    if (selector !== null) {
                        const target = event.target?.nodeType === 1
                            ? event.target : event.target?.parentElement;
                        // Native closest() cannot understand MiniDOM custom
                        // pseudo-selectors. Walk ancestors and use our matcher.
                        // Stop at the delegation root; never match outside it.
                        let match = target;
                        while (match && match !== element) {
                            if (match.nodeType === 1 && selectorMatch(match, selector)) break;
                            match = match.parentElement;
                        }
                        if (!match || match === element || !element.contains?.(match)) return;
                        context = match;
                    }
                    if (removeOnce) unbindRecord(element, record);
                    event.data = eventData;
                    event.delegateTarget = element;
                    event.handleObj = { type: token.type, selector, handler, namespace: token.namespaces.join('.'), _record: record };
                    // Match the conventional jQuery-style `return false` contract:
                    // cancel the default action and stop bubbling. Other handlers
                    // on this target still run unless stopImmediatePropagation()
                    // is explicitly called by the callback.
                    if (handler.call(context, event) === false) {
                        event.preventDefault();
                        event.stopPropagation();
                    }
                };
                const listenerOptions = capture && !requestedCapture
                    ? { ...(typeof nativeOptions === 'object' && nativeOptions ? nativeOptions : {}), capture: true }
                    : nativeOptions;
                record.options = listenerOptions;
                element.addEventListener(token.type, record.wrapped, listenerOptions);
                records.push(record);
                eventMemory.set(element, records);
                if (signal) {
                    record.abortHandler = () => unbindRecord(element, record);
                    // Installing the abort hook is part of registration. If a
                    // custom signal rejects it, roll back the native listener
                    // and our record instead of leaving a half-bound handler.
                    try {
                        signal.addEventListener('abort', record.abortHandler, { once: true });
                    } catch (error) {
                        unbindRecord(element, record);
                        throw error;
                    }
                    if (signal.aborted) unbindRecord(element, record);
                }
            }
        });
    }


    // Measurements return CSS pixel numbers for the first selected item.
    // Element dimensions use the untransformed CSS box model, excluding
    // margins except when explicitly requested. For non-rendered elements
    // (display:none, disconnected), the rendered dimensions are zero.
    function dimensionOf(target, axis, box = 'content', includeMargin = false) {
        if (!target) return undefined;
        if (target === global) return axis === 'width' ? global.innerWidth : global.innerHeight;
        if (target.nodeType === 9) {
            const doc = target;
            const root = doc.documentElement;
            const body = doc.body;
            const suffix = axis === 'width' ? 'Width' : 'Height';
            const values = [doc.defaultView?.['inner' + suffix] || 0];
            for (const node of [root, body]) {
                if (!node) continue;
                values.push(node['scroll' + suffix] || 0,
                    node['offset' + suffix] || 0, node['client' + suffix] || 0);
            }
            return Math.max(...values);
        }
        if (target.nodeType !== 1) return undefined;

        const style = global.getComputedStyle(target);
        if (style.display === 'none' || !target.getClientRects().length) return 0;
        const horizontal = axis === 'width';
        const p1 = parseFloat(style[horizontal ? 'paddingLeft' : 'paddingTop']) || 0;
        const p2 = parseFloat(style[horizontal ? 'paddingRight' : 'paddingBottom']) || 0;
        const b1 = parseFloat(style[horizontal ? 'borderLeftWidth' : 'borderTopWidth']) || 0;
        const b2 = parseFloat(style[horizontal ? 'borderRightWidth' : 'borderBottomWidth']) || 0;
        const padding = p1 + p2;
        const border = b1 + b2;
        const cssSize = parseFloat(style[axis]);
        // Computed width/height are normally resolved layout pixels. Unlike
        // getBoundingClientRect(), these values are unaffected by transforms.
        const borderBox = Number.isFinite(cssSize)
            ? cssSize + (style.boxSizing === 'border-box' ? 0 : padding + border)
            : (horizontal ? target.getBoundingClientRect().width : target.getBoundingClientRect().height);
        const content = Math.max(0, borderBox - padding - border);
        let result = content;
        if (box === 'inner' || box === 'outer') result += padding;
        if (box === 'outer') result += border;
        if (includeMargin) {
            result += (parseFloat(style[horizontal ? 'marginLeft' : 'marginTop']) || 0)
                + (parseFloat(style[horizontal ? 'marginRight' : 'marginBottom']) || 0);
        }
        return result;
    }

    function scrollOf(target, axis, value) {
        if (!target) return undefined;
        const isDocument = target.nodeType === 9;
        const view = isDocument ? target.defaultView : target === global ? global : null;
        const property = axis === 'top' ? 'scrollTop' : 'scrollLeft';
        const offsetProperty = axis === 'top' ? 'pageYOffset' : 'pageXOffset';
        const scrollElement = isDocument ? target.scrollingElement || target.documentElement : target;
        if (value === undefined) {
            if (view) return view[offsetProperty] || 0;
            return scrollElement[property];
        }
        if (view) {
            const x = axis === 'left' ? value : view.pageXOffset;
            const y = axis === 'top' ? value : view.pageYOffset;
            view.scrollTo(x, y);
        } else if (property in scrollElement) {
            scrollElement[property] = value;
        }
    }

    // A single native ResizeObserver serves every MiniDOM subscription.
    // Each target has a Set of callbacks, so registering the same callback
    // more than once is idempotent. Resize callbacks report content-box size.
    function getResizeObserver() {
        if (!global.ResizeObserver) {
            throw new Error('ResizeObserver is not supported by this browser');
        }
        if (!sharedResizeObserver) {
            sharedResizeObserver = new global.ResizeObserver(entries => {
                for (const entry of entries) {
                    const callbacks = resizeMemory.get(entry.target);
                    if (!callbacks) continue;
                    for (const callback of [...callbacks]) {
                        // A callback may unsubscribe itself or another callback.
                        if (!callbacks.has(callback)) continue;
                        callback.call(entry.target, entry.contentRect.width,
                            entry.contentRect.height, entry);
                    }
                }
            });
        }
        return sharedResizeObserver;
    }

    function addResizeListener(element, callback) {
        let callbacks = resizeMemory.get(element);
        if (!callbacks) {
            // Observe before publishing state: if observe() throws, a later
            // registration must not mistake this target for subscribed.
            getResizeObserver().observe(element);
            callbacks = new Set();
            resizeMemory.set(element, callbacks);
        }
        callbacks.add(callback);
    }

    function removeResizeListeners(element, callback) {
        const callbacks = resizeMemory.get(element);
        if (!callbacks) return;
        if (callback === undefined) callbacks.clear();
        else callbacks.delete(callback);
        if (!callbacks.size) {
            // Clear the registration before invoking a possibly patched
            // observer, so failures cannot retain callbacks or block cleanup.
            resizeMemory.delete(element);
            try { sharedResizeObserver?.unobserve(element); }
            catch (_) { /* cleanup is best effort */ }
        }
    }

    // MiniDOM stores events, data, display, and resize listeners in WeakMaps.
    // Detaching a node leaves them intact; destructive removals clean the
    // entire subtree (including text nodes with MiniDOM listeners).
    function cleanNode(node) {
        const records = eventMemory.get(node);
        // Most DOM nodes have no MiniDOM listeners. Avoid allocating an
        // empty snapshot array for every node during destructive cleanup.
        if (records && records.length) {
            for (const record of [...records]) unbindRecord(node, record);
        }
        dataMemory.delete(node);
        displayMemory.delete(node);
        removeResizeListeners(node);
        const observers = mutationMemory.get(node);
        if (observers) {
            // Delete first: queued callbacks must see the subscription as
            // removed, even if a custom disconnect() implementation throws.
            mutationMemory.delete(node);
            for (const observer of observers.values()) {
                try { observer.disconnect(); }
                catch (_) { /* continue cleaning remaining resources */ }
            }
        }
        const animation = fadeMemory.get(node);
        if (animation) {
            // Cancellation may invoke user-controlled animation hooks or
            // throw in custom/polyfilled implementations. Never let a failed
            // cancellation retain the entry or abort the remaining subtree.
            fadeMemory.delete(node);
            try { animation.cancel(); } catch (_) { /* cleanup is best effort */ }
        }
    }

    function cleanTree(node) {
        if (!node) return;
        // Cleanup has no dependency on child-before-parent ordering. A single
        // pre-order stack avoids allocating two stack entries per DOM node.
        // Snapshot children before cleaning the current node: cancelling
        // observers or animations must not affect traversal coverage.
        const stack = [node];
        while (stack.length) {
            const current = stack.pop();
            const children = current.childNodes;
            if (children) for (let i = children.length - 1; i >= 0; i--)
                stack.push(children[i]);
            if (current.nodeType === 1 && current.localName === 'template' &&
                current.namespaceURI === 'http://www.w3.org/1999/xhtml') {
                stack.push(current.content);
            }
            // Open shadow roots are separate DOM subtrees, not childNodes.
            // A removed host must release MiniDOM-managed listeners, data,
            // observers and animations inside its shadow tree as well.
            // Closed roots cannot be reached through the public DOM API.
            if (current.nodeType === 1 && current.shadowRoot) {
                stack.push(current.shadowRoot);
            }
            cleanNode(current);
        }
    }

    function cleanChildren(node) {
        // Walk existing siblings directly instead of allocating an array of
        // every child. Save the next sibling before invoking cleanup so a
        // user-supplied animation cancellation cannot interrupt traversal.
        let child = node.firstChild;
        while (child) {
            const next = child.nextSibling;
            cleanTree(child);
            child = next;
        }
    }

    // Copy user data without accidentally sharing ordinary nested objects.
    // Cycles and common built-in structured values are supported. Functions,
    // DOM nodes and non-plain class instances retain their identity.
    function copyDataValue(value) {
        if (value === null || typeof value !== 'object' || isNode(value)) return value;
        const seen = new WeakMap();
        const pending = [];
        function allocate(input) {
            if (input === null || typeof input !== 'object' || isNode(input)) return input;
            if (seen.has(input)) return seen.get(input);
            let output;
            if (Array.isArray(input)) output = new Array(input.length);
            else if (input instanceof ArrayBuffer) output = input.slice(0);
            else if (typeof global.SharedArrayBuffer === 'function' &&
                input instanceof global.SharedArrayBuffer) {
                // Unlike ArrayBuffer, SharedArrayBuffer has no slice-based
                // isolation guarantee for consumers. Copy its bytes into a
                // separate shared backing store, preserving graph aliasing.
                output = new global.SharedArrayBuffer(input.byteLength);
                new Uint8Array(output).set(new Uint8Array(input));
            }
            else if (ArrayBuffer.isView(input)) {
                // Views must point at the same *cloned* backing buffer, not
                // independently copied buffers. Preserve offsets and lengths.
                const buffer = allocate(input.buffer);
                output = input instanceof DataView
                    ? new DataView(buffer, input.byteOffset, input.byteLength)
                    : new input.constructor(buffer, input.byteOffset, input.length);
            }
            else if (input instanceof Date) output = new Date(input.getTime());
            else if (input instanceof RegExp) {
                output = new RegExp(input.source, input.flags);
                output.lastIndex = input.lastIndex;
            } else if (input instanceof Map) output = new Map();
            else if (input instanceof Set) output = new Set();
            else {
                const prototype = Object.getPrototypeOf(input);
                if (prototype !== Object.prototype && prototype !== null) return input;
                output = Object.create(prototype);
            }
            seen.set(input, output);
            if (Array.isArray(input) || input instanceof Map || input instanceof Set ||
                (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null)) {
                pending.push([input, output]);
            }
            return output;
        }
        const root = allocate(value);
        while (pending.length) {
            const [input, output] = pending.pop();
            if (input instanceof Map) {
                for (const [key, item] of input) output.set(allocate(key), allocate(item));
            } else if (input instanceof Set) {
                for (const item of input) output.add(allocate(item));
            } else {
                // Object.keys() omits enumerable Symbol properties. Preserve
                // those too, including their shared/cyclic value references.
                const keys = [...Object.keys(input), ...Object.getOwnPropertySymbols(input)
                    .filter(key => Object.prototype.propertyIsEnumerable.call(input, key))];
                for (const key of keys) {
                    Object.defineProperty(output, key, {
                        value: allocate(input[key]), enumerable: true, writable: true, configurable: true
                    });
                }
            }
        }
        return root;
    }

    // Only MiniDOM-managed listeners can be copied; the browser provides no
    // API to introspect listeners added using native addEventListener().
    function copyManagedState(source, destination) {
        const saved = dataMemory.get(source);
        if (saved) dataMemory.set(destination, copyDataValue(saved));
        const display = displayMemory.get(source);
        if (display) displayMemory.set(destination, { ...display });
        const resizeCallbacks = resizeMemory.get(source);
        if (resizeCallbacks && destination.nodeType === 1) {
            for (const callback of resizeCallbacks) addResizeListener(destination, callback);
        }
        for (const record of eventMemory.get(source) || []) {
            bindEvents(new Collection([destination]), [record.type, ...record.namespaces].join('.'), record.selector,
                record.handler, record.eventData === undefined ? record.options :
                    { ...(typeof record.options === 'object' ? record.options : { capture: record.capture }),
                        data: record.eventData }, record.once);
        }
    }

    function cloneNodeWithState(source, copyState = false, deepState = copyState) {
        const cloned = source.cloneNode(true);
        // Copy each source node exactly once, including the root.
        if (copyState && !deepState) copyManagedState(source, cloned);
        if (copyState && deepState) {
            // Pairwise iterative traversal includes inert template.content trees.
            // Native cloneNode(true) clones these fragments, but they are not
            // exposed through the template element's childNodes collection.
            const stack = [[source, cloned]];
            while (stack.length) {
                const [from, to] = stack.pop();
                copyManagedState(from, to);
                // cloneNode(true) can include a shadow tree when its host was
                // created with { clonable: true }. Traverse it only when the
                // browser actually cloned an accessible open shadow root.
                // Non-clonable and closed roots remain untouched.
                if (from.nodeType === 1 && from.shadowRoot && to.shadowRoot) {
                    stack.push([from.shadowRoot, to.shadowRoot]);
                }
                if (from.nodeType === 1 && from.localName === 'template' &&
                    from.namespaceURI === 'http://www.w3.org/1999/xhtml') {
                    const fromFragment = from.content;
                    const toFragment = to.content;
                    stack.push([fromFragment, toFragment]);
                }
                for (let i = from.childNodes.length - 1; i >= 0; i--) {
                    const fromChild = from.childNodes[i];
                    const toChild = to.childNodes[i];
                    stack.push([fromChild, toChild]);
                }
            }
        }
        return cloned;
    }

    // An insertion accepts HTML/text, native nodes, MiniDOM selections, and
    // (possibly nested) iterables of these. Raw HTML must be trusted.
    function contentNodes(value) {
        // Flatten nested content without recursion or large argument spreads.
        // Track only active containers: repeated references are valid, cycles
        // are not and would otherwise keep the traversal running forever.
        const result = [];
        const active = new Set();
        const stack = [{ value, exit: false }];
        while (stack.length) {
            const frame = stack.pop();
            const item = frame.value;
            if (frame.exit) { active.delete(item); continue; }
            if (item == null) continue;
            if (typeof item === 'string' ||
                (global.TrustedHTML && item instanceof global.TrustedHTML)) {
                // Empty strings are no-ops, and must not reach an HTML sink:
                // enforced Trusted Types CSP rejects even template.innerHTML = ''.
                if (item === '') continue;
                // Keep the TrustedHTML brand intact when a policy supplied it.
                const template = global.document.createElement('template');
                template.innerHTML = item;
                for (const child of template.content.childNodes) result.push(child);
            } else if (typeof item === 'number' || typeof item === 'boolean') {
                result.push(global.document.createTextNode(String(item)));
            } else if (isNode(item)) {
                if (item.nodeType === 11) {
                    for (const child of item.childNodes) result.push(child);
                } else result.push(item);
            } else {
                const iterable = item instanceof Collection ? item.elements : item;
                if (iterable == null || typeof iterable[Symbol.iterator] !== 'function') continue;
                if (active.has(iterable)) throw new TypeError('Cyclic DOM content iterable');
                active.add(iterable);
                stack.push({ value: iterable, exit: true });
                const children = Array.from(iterable);
                for (let i = children.length - 1; i >= 0; i--)
                    stack.push({ value: children[i], exit: false });
            }
        }
        return result;
    }

    // Keep selected roots in their original order, discarding descendants
    // already carried by a selected ancestor. Also deduplicate references.
    // This avoids quadratic pairwise comparisons for large sibling selections.
    function topLevelNodes(items) {
        const selected = new Set(items);
        // A template's .content fragment has no parentNode pointing back to
        // its host. Treat selected templates as ancestors of their content
        // nodes so a source selection cannot accidentally extract both.
        const templateHosts = new Map();
        // Map nested template fragments too. A selected node can live inside
        // several inert template.content boundaries, none of which expose a
        // parentNode link back to their owning <template> element.
        const pending = [];
        for (const node of selected) {
            if (node?.nodeType === 1 && node.localName === 'template' &&
                node.namespaceURI === 'http://www.w3.org/1999/xhtml') pending.push(node);
        }
        const visited = new Set();
        while (pending.length) {
            const template = pending.pop();
            if (visited.has(template)) continue;
            visited.add(template);
            templateHosts.set(template.content, template);
            // Only traverse inert content of selected template roots. Ordinary
            // DOM descendants already have parentNode ancestry.
            const stack = [...template.content.childNodes];
            while (stack.length) {
                const child = stack.pop();
                if (child.nodeType === 1 && child.localName === 'template' &&
                    child.namespaceURI === 'http://www.w3.org/1999/xhtml') {
                    if (!visited.has(child)) pending.push(child);
                } else if (child.childNodes?.length) {
                    for (const nested of child.childNodes) stack.push(nested);
                }
            }
        }
        return unique(items).filter(node => {
            for (let parent = node.parentNode; parent;) {
                if (selected.has(parent)) return false;
                parent = parent.parentNode || templateHosts.get(parent) || null;
            }
            return true;
        });
    }

    // Template contents live in an inert DocumentFragment whose parentNode is
    // null. When a selected template and one of its content descendants are
    // both selected for destructive removal/detachment, keep the descendant
    // inside the detached template rather than pulling it out separately.
    function removalRoots(items) {
        const roots = topLevelNodes(items);
        const selectedContents = new Set(roots.filter(node =>
            node.nodeType === 1 && node.localName === 'template' &&
            node.namespaceURI === 'http://www.w3.org/1999/xhtml')
            .map(node => node.content));
        if (!selectedContents.size) return roots;
        return roots.filter(node => {
            for (let parent = node.parentNode; parent; parent = parent.parentNode) {
                if (selectedContents.has(parent)) return false;
            }
            return true;
        });
    }

    // Filter replacement targets in one ancestor walk per target, rather than
    // comparing each target against every source. Sources may not replace
    // themselves or their own descendants.
    function replacementTargets(targets, sources) {
        const sourceSet = new Set(sources);
        return topLevelNodes(targets.filter(node => {
            if (!isNode(node) || !node.parentNode) return false;
            for (let current = node; current; current = current.parentNode) {
                if (sourceSet.has(current)) return false;
            }
            return true;
        }));
    }

    // For multiple destinations: clone for all but the final destination;
    // move original source nodes into the last. Preserve insertion order.
    function insertNodes(destinations, source, position) {
        // A descendant selected alongside its ancestor already travels with
        // that ancestor. Moving it separately would flatten the DOM tree.
        // Preserve the original order of the remaining top-level sources.
        // Walk each source's actual ancestor chain instead of comparing every
        // source against every other source (quadratic for large sibling lists).
        source = topLevelNodes(source);
        const targets = unique(Array.from(destinations)).filter(target =>
            isNode(target) && ((position === 'before' || position === 'after')
                ? Boolean(target.parentNode && target.before && target.after)
                : Boolean(target.append && target.prepend))
        );
        const inserted = [];
        // A node cannot be inserted into itself or one of its descendants.
        // Skip invalid destinations without disturbing other targets.
        // A destination is invalid if it is a source node or is nested
        // inside one. Checking each target's ancestor chain against a Set
        // avoids the source-count × target-count containment scan.
        const sourceSet = new Set(source);
        const validTargets = targets.filter(target => {
            for (let node = target; node; node = node.parentNode) {
                if (sourceSet.has(node)) return false;
            }
            return true;
        });
        if (!validTargets.length) return inserted;
        // HTML templates store children in .content, not their own childNodes.
        const insertionTarget = target =>
            (position === 'append' || position === 'prepend') &&
            target.nodeType === 1 && target.localName === 'template' &&
            target.namespaceURI === 'http://www.w3.org/1999/xhtml'
                ? target.content : target;
        // Avoid creating a DocumentFragment for the most common case: one
        // destination and one source node. The native insertion moves the node.
        if (validTargets.length === 1 && source.length === 1) {
            insertionTarget(validTargets[0])[position](source[0]);
            return [source[0]];
        }
        validTargets.forEach((target, index) => {
            const copies = index === validTargets.length - 1
                ? source
                : source.map(node => cloneNodeWithState(node, true));
            if (!copies.length) return;
            // Build the fragment in the destination document. Native adoption
            // still handles foreign source nodes, but the insertion container
            // must belong to the receiving DOM (including iframe documents).
            const destination = insertionTarget(target);
            const owner = destination.nodeType === 9 ? destination : destination.ownerDocument;
            const fragment = owner.createDocumentFragment();
            for (const copy of copies) fragment.appendChild(copy);
            destination[position](fragment);
            for (const copy of copies) inserted.push(copy);
        });
        return inserted;
    }

    // Compile once per traversal, not once per element. For a node-list or
    // Collection selector this avoids materializing the same list N times.
    function selectorMatch(element, selector) {
        if (element == null) return false;
        if (typeof selector !== 'string') return false;
        if (selector === ':input') return element.matches?.('input,select,textarea,button') || false;
        if (selector === ':header') return element.matches?.('h1,h2,h3,h4,h5,h6') || false;
        if (selector === ':parent') return Boolean(element.childNodes?.length);
        if (selector === ':selected') return Boolean(element.selected);
        if (selector === ':animated') return Boolean(fadeMemory.get(element));
        const form = /^:(checkbox|radio|button|text|file|password|submit|reset)$/.exec(selector);
        if (form) {
            const type = form[1];
            if (type === 'button') return element.matches?.('button,input[type="button"]') || false;
            if (type === 'text') return element.matches?.('input:not([type]),input[type="text"]') || false;
            return element.matches?.('input[type="' + type + '"]') || false;
        }

        if (selector === ':visible') return new Collection([element]).isVisible();
        if (selector === ':hidden') return !new Collection([element]).isVisible();
        const content = /^:contains\((.*)\)$/s.exec(selector.trim());
        if (content) {
            let value = content[1].trim();
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
            return (element.textContent || '').includes(value);
        }
        if (typeof element.matches !== 'function') return false;
        customPseudo.lastIndex = 0;
        if (customPseudo.test(selector)) {
            customPseudo.lastIndex = 0;
            const root = element.getRootNode?.() || global.document;
            if (queryExtended(selector, [root]).includes(element)) return true;
            // querySelectorAll() excludes its root. Detached elements are their
            // own root, so a compound custom pseudo would otherwise never
            // match them (e.g. $(detached).is('div:contains(hello)')).
            // Only evaluate a single selector step locally; combinators and
            // positional queries spanning multiple nodes retain query semantics.
            if (root !== element) return false;
            const groups = selectorPlan(selector);
            for (const group of groups) {
                if (group.length !== 1 || group[0].combinator) continue;
                const { nativeCSS, tests, notEqual } = group[0];
                if (!element.matches(nativeCSS) || !notEqual.every(([name, value]) =>
                    element.getAttribute(name) !== value)) continue;
                let matched = [element];
                for (const test of tests) matched = applyPseudo(matched, test);
                if (matched.includes(element)) return true;
            }
            return false;
        }
        customPseudo.lastIndex = 0;
        return element.matches(selector);
    }

    function matcher(selector) {
        if (typeof selector === 'function') {
            return (element, index) => Boolean(selector.call(element, index, element));
        }
        if (typeof selector === 'string') {
            return element => selectorMatch(element, selector);
        }
        const accepted = new Set(nodes(selector));
        return element => accepted.has(element);
    }

    class Collection {
        constructor(elements, previous = null) {
            this.elements = unique(elements);
            this.previous = previous;
            // jQuery-like [0], [1], ... access (native nodes, not wrappers).
            this.elements.forEach((element, index) => { this[index] = element; });
        }

        get length() {
            return this.elements.length;
        }

        _push(elements) {
            return new Collection(elements, this);
        }

        each(callback) {
            this.elements.forEach((element, index) => callback.call(element, index, element));
            return this;
        }

        get(index = 0) {
            return this.elements.at(index);
        }

        // Returns a copy, so callers cannot mutate the collection's internals.
        toArray() { return [...this.elements]; }

        // With no argument, the first element's sibling index. A string checks
        // its position in the global CSS selection; a node/collection checks
        // whether that node appears in this selection. -1 means not found.
        index(value) {
            if (value === undefined) {
                const element = this.get();
                return element?.parentElement ? Array.prototype.indexOf.call(element.parentElement.children, element) : -1;
            }
            if (typeof value === 'string') return Array.prototype.indexOf.call(select(value), this.get());
            return this.elements.indexOf(value instanceof Collection ? value.get() : value);
        }

        first() { return this.eq(0); }
        last() { return this.eq(-1); }
        eq(index) { return this._push([this.get(index)]); }
        end() { return this.previous || new Collection([]); }

        find(selector) {
            if (typeof selector !== 'string') {
                const targets = nodes(selector);
                return this._push(targets.filter(target => this.elements.some(root =>
                    root !== target && root?.contains?.(target))));
            }
            return this._push(queryExtended(selector, this.elements));
        }

        parent(selector) {
            const accepts = selector == null ? null : matcher(selector);
            const found = [];
            for (const element of this.elements) {
                const parent = element?.parentElement;
                if (parent && (!accepts || accepts(parent))) found.push(parent);
            }
            return this._push(found);
        }

        children(selector) {
            const accepts = selector == null ? null : matcher(selector);
            const found = [];
            for (const element of this.elements) {
                if (!element) continue;
                const target = element.nodeType === 1 && element.localName === 'template' &&
                    element.namespaceURI === 'http://www.w3.org/1999/xhtml'
                    ? element.content : element;
                if (!target.children) continue;
                for (const child of target.children) {
                    if (!accepts || accepts(child)) found.push(child);
                }
            }
            return this._push(found);
        }

        closest(selector, context) {
            const found = [];
            for (const element of this.elements) {
                if (typeof element?.closest !== 'function') continue;
                const boundary = context == null ? null :
                    (typeof context === 'string' ? select(context)[0] : nodes(context)[0]);
                let match = element;
                while (match && match !== boundary && !selectorMatch(match, selector)) match = match.parentElement;
                if (match === boundary) match = null;
                if (match) found.push(match);
            }
            return this._push(found);
        }

        parents(selector) { return this._walk('parentElement', selector); }
        parentsUntil(until, selector) { return this._walk('parentElement', selector, until); }
        nextAll(selector) { return this._walk('nextElementSibling', selector); }
        prevAll(selector) { return this._walk('previousElementSibling', selector); }
        nextUntil(until, selector) { return this._walk('nextElementSibling', selector, until); }
        prevUntil(until, selector) { return this._walk('previousElementSibling', selector, until); }
        _walk(direction, selector, until) {
            const accepts = selector === undefined ? () => true : matcher(selector);
            const stops = until === undefined ? () => false : matcher(until);
            const found = [];
            for (const element of this.elements) {
                let node = element?.[direction];
                while (node && node.nodeType === 1) {
                    if (stops(node)) break;
                    if (accepts(node)) found.push(node);
                    node = node[direction];
                }
            }
            return this._push(found);
        }
        contents() {
            const found = [];
            for (const element of this.elements) {
                if (!element) continue;
                if (element.contentDocument) found.push(element.contentDocument);
                else if (element.tagName === 'TEMPLATE') for (const child of element.content.childNodes) found.push(child);
                else if (element.childNodes) for (const child of element.childNodes) found.push(child);
            }
            return this._push(found);
        }
        addBack(selector) {
            if (!this.previous) return this._push(this.elements);
            const previous = selector === undefined ? this.previous.elements :
                this.previous.elements.filter(matcher(selector));
            return this._push([...this.elements, ...previous]);
        }
        map(callback) {
            if (typeof callback !== 'function') throw new TypeError('map() requires callback');
            const found = [];
            this.each((i, element) => {
                const value = callback.call(element, i, element);
                if (value == null) return;
                if (value instanceof Collection) for (const item of value.elements) found.push(item);
                else if (Array.isArray(value)) for (const item of value) found.push(item);
                else found.push(value);
            });
            return this._push(found);
        }
        even() { return this._push(this.elements.filter((_, i) => i % 2 === 0)); }
        odd() { return this._push(this.elements.filter((_, i) => i % 2 === 1)); }

        // Positional pseudo-selectors on a collection refer to that collection,
        // not to the first matching element in the entire document.
        _positionalSelection(selector) {
            if (typeof selector !== 'string') return null;
            const match = /^:(first|last|even|odd|eq\(-?\d+\)|lt\(-?\d+\)|gt\(-?\d+\))$/.exec(selector);
            return match ? new Set(applyPseudo(this.elements, match[1])) : null;
        }

        filter(selector) {
            const positional = this._positionalSelection(selector);
            if (positional) return this._push(this.elements.filter(element => positional.has(element)));
            // Negation of a positional pseudo also operates on this collection.
            if (typeof selector === 'string') {
                const negated = /^:not\((:(?:first|last|even|odd|eq\(-?\d+\)|lt\(-?\d+\)|gt\(-?\d+\)))\)$/.exec(selector);
                if (negated) {
                    const excluded = this._positionalSelection(negated[1]);
                    return this._push(this.elements.filter(element => !excluded.has(element)));
                }
            }
            return this._push(this.elements.filter(matcher(selector)));
        }

        not(selector) {
            const positional = this._positionalSelection(selector);
            if (positional) return this._push(this.elements.filter(element => !positional.has(element)));
            const matches = matcher(selector);
            return this._push(this.elements.filter((element, index) => !matches(element, index)));
        }

        is(selector) {
            const positional = this._positionalSelection(selector);
            if (positional) return positional.size > 0;
            return this.elements.some(matcher(selector));
        }

        // Keep only elements containing a matching descendant. Unlike find(),
        // this returns the outer elements and preserves .end() traversal.
        has(selector) {
            if (typeof selector === 'string') {
                // querySelector() rejects MiniDOM-only pseudos; use the same
                // selector path as $() so .has(':visible') works consistently.
                return this._push(this.elements.filter(element =>
                    queryExtended(selector, [element]).length > 0));
            }
            const targets = nodes(selector);
            return this._push(this.elements.filter(element =>
                typeof element?.contains === 'function' &&
                targets.some(child => child !== element && element.contains(child))
            ));
        }

        add(selector, context) {
            return this._push([...this.elements, ...select(selector, context)]);
        }

        siblings(selector) {
            const matches = selector === undefined ? null : matcher(selector);
            const found = [];
            let index = 0;
            for (const element of this.elements) {
                if (!element?.parentElement) continue;
                for (const sibling of element.parentElement.children) {
                    if (sibling === element) continue;
                    if (!matches || matches(sibling, index)) found.push(sibling);
                    index++;
                }
            }
            return this._push(found);
        }

        next(selector) {
            const matches = selector === undefined ? null : matcher(selector);
            const found = [];
            let index = 0;
            for (const element of this.elements) {
                const sibling = element?.nextElementSibling;
                if (!sibling) continue;
                if (!matches || matches(sibling, index)) found.push(sibling);
                index++;
            }
            return this._push(found);
        }

        prev(selector) {
            const matches = selector === undefined ? null : matcher(selector);
            const found = [];
            let index = 0;
            for (const element of this.elements) {
                const sibling = element?.previousElementSibling;
                if (!sibling) continue;
                if (!matches || matches(sibling, index)) found.push(sibling);
                index++;
            }
            return this._push(found);
        }

        addClass(names) {
            return this.each((i, element) => {
                if (!element?.classList) return;
                const next = typeof names === 'function'
                    ? names.call(element, i, element.className) : names;
                const tokens = classes(next);
                if (tokens.length) updateClassTokens(element.classList, tokens, 'add');
            });
        }

        removeClass(names) {
            // Match addClass/toggleClass callback semantics, including the
            // element index and its class string before modification.
            const fixedTokens = typeof names === 'function' ? null : classes(names);
            return this.each((i, element) => {
                if (!element?.classList) return;
                const next = typeof names === 'function'
                    ? names.call(element, i, element.className) : null;
                const tokens = fixedTokens || classes(next);
                if (tokens.length) updateClassTokens(element.classList, tokens, 'remove');
            });
        }

        toggleClass(names, force) {
            return this.each((i, element) => {
                if (!element?.classList) return;
                const next = typeof names === 'function'
                    ? names.call(element, i, element.className, force) : names;
                for (const token of classes(next)) {
                    if (force === undefined) element.classList.toggle(token);
                    else element.classList.toggle(token, Boolean(force));
                }
            });
        }

        hasClass(name) {
            return this.elements.some(element =>
                Boolean(element?.classList?.contains(name))
            );
        }

        // Snapshot replacement destinations before mutating the DOM. A selected
        // descendant must not be modified after its selected ancestor removes
        // it; HTML template content has a separate DocumentFragment root.
        _replacementRoots() {
            const eligible = this.elements.filter(element =>
                isNode(element) && element.nodeType !== 9 &&
                (element.nodeType === 1 || element.nodeType === 11));
            const selected = new Set(eligible);
            return new Set(topLevelNodes(eligible).filter(element => {
                for (let parent = element.parentNode; parent; parent = parent.parentNode) {
                    if (parent.nodeType === 11 && eligible.some(candidate =>
                        candidate.localName === 'template' && candidate.content === parent)) return false;
                }
                return true;
            }));
        }

        text(value) {
            if (value === undefined) {
                const first = this.get();
                return first?.localName === 'template' && first.namespaceURI === 'http://www.w3.org/1999/xhtml'
                    ? first.content.textContent : first?.textContent;
            }
            const roots = this._replacementRoots();
            return this.each((i, element) => {
                if (!roots.has(element)) return;
                // Window and Document are valid selection roots but cannot
                // receive text content. In particular, never create an
                // accidental window.textContent property.
                if (!isNode(element) || element.nodeType === 9) return;
                const previous = element.localName === 'template' && element.namespaceURI === 'http://www.w3.org/1999/xhtml'
                    ? element.content.textContent : element.textContent;
                const next = typeof value === 'function' ? value.call(element, i, previous) : value;
                // Convert before destroying managed state: user-defined toString()
                // can throw, in which case the existing subtree must survive.
                const prepared = next == null ? '' : String(next);
                // Template descendants live in .content, not childNodes.
                const target = element.localName === 'template' && element.namespaceURI === 'http://www.w3.org/1999/xhtml'
                    ? element.content : element;
                cleanChildren(target);
                target.textContent = prepared;
            });
        }

        html(value) {
            if (value === undefined) return this.get()?.innerHTML;
            const roots = this._replacementRoots();
            return this.each((i, element) => {
                if (!roots.has(element)) return;
                // Collections may contain window, document, text nodes, or
                // caller-supplied non-DOM entries. Only HTML-capable nodes
                // should reach the parser or the functional setter callback.
                if (element != null && (typeof element === 'object' || typeof element === 'function') &&
                    'innerHTML' in element && isNode(element)) {
                    const next = typeof value === 'function' ? value.call(element, i, element.innerHTML) : value;
                    // Parse into a detached template before cleaning existing
                    // children. Invalid markup conversions or Trusted Types
                    // rejection must not destroy their managed state.
                    // Preserve native TrustedHTML objects rather than coercing
                    // them to strings (which would lose their Trusted Types brand).
                    const prepared = next == null ? '' :
                        (global.TrustedHTML && next instanceof global.TrustedHTML ? next : String(next));
                    // Empty content needs no HTML parser. In particular, a
                    // Trusted Types CSP must not reject .html(null) / .html(''),
                    // which only remove existing nodes and never create markup.
                    const target = element.localName === 'template' && element.namespaceURI === 'http://www.w3.org/1999/xhtml'
                        ? element.content : element;
                    if (prepared === '') {
                        cleanChildren(target);
                        target.replaceChildren();
                        return;
                    }
                    // HTML templates keep inserted scripts inert. For SVG/MathML,
                    // contextual parsing is necessary to preserve namespaces.
                    let fragment;
                    if (element.namespaceURI === 'http://www.w3.org/1999/xhtml') {
                        // Some HTML elements have context-sensitive parsing rules:
                        // table rows need implicit tbody, and raw-text/RCDATA
                        // elements must not interpret markup as child elements.
                        // Parse in a detached element of the same type, keeping
                        // scripts inert and preserving TrustedHTML under CSP.
                        const contextual = /^(?:table|thead|tbody|tfoot|tr|colgroup|select|optgroup|textarea|title|style|script)$/i.test(element.localName);
                        if (contextual) {
                            const parser = element.cloneNode(false);
                            parser.innerHTML = prepared;
                            fragment = element.ownerDocument.createDocumentFragment();
                            while (parser.firstChild) fragment.appendChild(parser.firstChild);
                        } else {
                            const template = element.ownerDocument.createElement('template');
                            template.innerHTML = prepared;
                            fragment = template.content;
                        }
                    } else {
                        const range = element.ownerDocument.createRange();
                        range.selectNodeContents(element);
                        fragment = range.createContextualFragment(prepared);
                        // Match the HTML-template path: never execute scripts
                        // supplied via .html(), including inside SVG/MathML.
                        for (const script of fragment.querySelectorAll('script')) {
                            script.remove();
                        }
                    }
                    // Parsing must succeed before destroying the old subtree.
                    cleanChildren(target);
                    target.replaceChildren(fragment);
                }
            });
        }

        val(value) {
            if (value === undefined) return readValue(this.get());
            return this.each((i, element) => {
                const next = typeof value === 'function' ? value.call(element, i, readValue(element)) : value;
                writeValue(element, next);
            });
        }

        // Returns the browser's native successful-controls snapshot. Files
        // stay as File objects, repeated field names remain separate entries.
        // Like value getters, this reads the first selected element only.
        formData(submitter) {
            const form = this.get();
            if (form === undefined) return undefined;
            if (!(form instanceof global.HTMLFormElement)) {
                throw new TypeError('formData() requires a <form> element');
            }

            // FormData(form, submitter) includes the clicked submit control,
            // unlike FormData(form). The browser validates the submitter.
            if (submitter !== undefined) {
                const button = submitter instanceof Collection ? submitter.get() : submitter;
                return new global.FormData(form, button);
            }
            return new global.FormData(form);
        }

        // jQuery-compatible value records. File entries are intentionally
        // omitted: serializeArray()/serialize() are for URL-encoded text,
        // while formData() is for multipart submissions and file uploads.
        serializeArray() {
            const data = this.formData();
            if (!data) return [];
            const entries = [];
            for (const [name, value] of data) {
                if (typeof value === 'string') entries.push({ name, value: value.replace(/\r?\n/g, '\r\n') });
            }
            return entries;
        }

        // Browser-native application/x-www-form-urlencoded encoding: repeated
        // names, Unicode, spaces, reserved characters are handled correctly.
        serialize() {
            return new global.URLSearchParams(
                this.serializeArray().map(({ name, value }) => [name, value])
            ).toString();
        }

        attr(name, value) {
            if (name && typeof name === 'object') {
                return this.each((i, element) => {
                    if (!element?.setAttribute || !element.getAttribute) return;
                    for (const [key, val] of Object.entries(name)) {
                        const next = typeof val === 'function' ? val.call(element, i, element.getAttribute(key)) : val;
                        if (next === null) element.removeAttribute(key);
                        else if (next !== undefined) element.setAttribute(key, String(next));
                    }
                });
            }
            if (value === undefined) return this.get()?.getAttribute?.(name);
            return this.each((i, element) => {
                if (!element?.setAttribute) return;
                const next = typeof value === 'function' ? value.call(element, i, element.getAttribute(name)) : value;
                if (next === null) element.removeAttribute(name);
                else if (next !== undefined) element.setAttribute(name, String(next));
            });
        }

        removeAttr(name) {
            const names = String(name).trim().split(/\s+/).filter(Boolean);
            return this.each((i, element) => {
                for (const attr of names) element?.removeAttribute?.(attr);
            });
        }

        css(property, value) {
            if (Array.isArray(property)) {
                const element = this.get();
                if (!element || element.nodeType !== 1) return undefined;
                const style = global.getComputedStyle(element), result = {};
                for (const name of property) result[name] = style.getPropertyValue(cssName(name));
                return result;
            }
            if (property && typeof property === 'object') {
                return this.each((i, element) => {
                    if (!element?.style) return;
                    for (const [name, newValue] of Object.entries(property)) {
                        const key = cssName(name);
                        const computed = typeof newValue === 'function'
                            ? newValue.call(element, i, global.getComputedStyle(element).getPropertyValue(key))
                            : newValue;
                        if (computed == null) element.style.removeProperty(key);
                        else element.style.setProperty(key, String(computed));
                    }
                });
            }

            // A declaration list (e.g. "color: red; padding: 8px") merges
            // into each element's existing inline style. Use the browser's
            // CSS parser so quoted semicolons, custom properties and
            // !important are handled correctly.
            if (typeof property === 'string' && value === undefined && property.includes(':')) {
                const parsed = global.document.createElement('div').style;
                parsed.cssText = property;
                const declarations = [];
                for (let i = 0; i < parsed.length; i++) {
                    const name = parsed.item(i);
                    declarations.push([name, parsed.getPropertyValue(name), parsed.getPropertyPriority(name)]);
                }
                return this.each((i, element) => {
                    if (!element?.style) return;
                    for (const [name, newValue, priority] of declarations) {
                        element.style.setProperty(name, newValue, priority);
                    }
                });
            }

            const key = cssName(String(property));
            if (value === undefined) {
                const element = this.get();
                return element && element.nodeType === 1
                    ? global.getComputedStyle(element).getPropertyValue(key)
                    : undefined;
            }

            return this.each((i, element) => {
                if (!element?.style) return;
                const computed = typeof value === 'function'
                    ? value.call(element, i, global.getComputedStyle(element).getPropertyValue(key))
                    : value;
                if (computed == null) element.style.removeProperty(key);
                else element.style.setProperty(key, String(computed));
            });
        }

        hide() {
            return this.each((i, element) => {
                if (!element?.style) return;
                if (!displayMemory.has(element)) {
                    const original = element.style.getPropertyValue('display');
                    displayMemory.set(element, {
                        value: original === 'none' ? '' : original,
                        priority: original === 'none' ? '' : element.style.getPropertyPriority('display')
                    });
                }
                element.style.setProperty('display', 'none', 'important');
            });
        }

        show() {
            return this.each((i, element) => {
                if (!element?.style) return;
                const stored = displayMemory.get(element);
                if (stored) {
                    if (stored.value) element.style.setProperty('display', stored.value, stored.priority);
                    else element.style.removeProperty('display');
                    displayMemory.delete(element);
                } else if (element.style.getPropertyValue('display') === 'none') {
                    element.style.removeProperty('display');
                }
            });
        }


        // Dimension getters use the first matched node and return CSS pixels.
        // For window: viewport dimensions; for document: full page dimensions.
        // These are snapshots; use observeResize() to react to element changes.
        width(value) { return this._dimension('width', value); }
        height(value) { return this._dimension('height', value); }
        _dimension(axis, value) {
            if (value === undefined) return dimensionOf(this.get(), axis);
            return this.each((i, element) => {
                if (!element?.style) return;
                const previous = dimensionOf(element, axis);
                const next = typeof value === 'function' ? value.call(element, i, previous) : value;
                if (next == null) { element.style.removeProperty(axis); return; }
                if (typeof next === 'number' && !Number.isFinite(next))
                    throw new TypeError('Dimension must be finite');
                const target = typeof next === 'number' ? Math.max(0, next) + 'px' : String(next);
                // width()/height() use content-box sizes regardless of box-sizing.
                if (typeof next === 'number' && global.getComputedStyle(element).boxSizing === 'border-box') {
                    const style = global.getComputedStyle(element);
                    const extras = axis === 'width'
                        ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) +
                          parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
                        : parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) +
                          parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
                    element.style.setProperty(axis, (Math.max(0, next) + (extras || 0)) + 'px');
                } else element.style.setProperty(axis, target);
            });
        }
        innerWidth(value) { return this._boxDimension('width', 'inner', value); }
        innerHeight(value) { return this._boxDimension('height', 'inner', value); }
        outerWidth(value, includeMargin = false) {
            if (typeof value === 'boolean' || value === undefined)
                return dimensionOf(this.get(), 'width', 'outer', Boolean(value));
            return this._boxDimension('width', 'outer', value, includeMargin);
        }
        outerHeight(value, includeMargin = false) {
            if (typeof value === 'boolean' || value === undefined)
                return dimensionOf(this.get(), 'height', 'outer', Boolean(value));
            return this._boxDimension('height', 'outer', value, includeMargin);
        }
        _boxDimension(axis, box, value, includeMargin = false) {
            if (value === undefined) return dimensionOf(this.get(), axis, box, includeMargin);
            return this.each((i, element) => {
                if (!element?.style) return;
                const current = dimensionOf(element, axis, box, includeMargin);
                const next = typeof value === 'function' ? value.call(element, i, current) : value;
                if (next == null) { element.style.removeProperty(axis); return; }
                if (typeof next !== 'number' || !Number.isFinite(next))
                    throw new TypeError('Box dimension setter requires a finite number');
                const style = global.getComputedStyle(element);
                const horizontal = axis === 'width';
                const padding = (parseFloat(style[horizontal ? 'paddingLeft' : 'paddingTop']) || 0) +
                    (parseFloat(style[horizontal ? 'paddingRight' : 'paddingBottom']) || 0);
                const border = (parseFloat(style[horizontal ? 'borderLeftWidth' : 'borderTopWidth']) || 0) +
                    (parseFloat(style[horizontal ? 'borderRightWidth' : 'borderBottomWidth']) || 0);
                const margin = includeMargin ?
                    (parseFloat(style[horizontal ? 'marginLeft' : 'marginTop']) || 0) +
                    (parseFloat(style[horizontal ? 'marginRight' : 'marginBottom']) || 0) : 0;
                const contentSize = Math.max(0, next - padding - (box === 'outer' ? border + margin : 0));
                new Collection([element])._dimension(axis, contentSize);
            });
        }

        // Scroll getters return a number. Setters apply to every matched node
        // and return the same wrapper for chaining.
        scrollTop(value) {
            if (value === undefined) return scrollOf(this.get(), 'top');
            const num = Number(value);
            if (!Number.isFinite(num)) throw new TypeError('scrollTop() requires a finite number');
            return this.each((i, element) => scrollOf(element, 'top', num));
        }

        scrollLeft(value) {
            if (value === undefined) return scrollOf(this.get(), 'left');
            const num = Number(value);
            if (!Number.isFinite(num)) throw new TypeError('scrollLeft() requires a finite number');
            return this.each((i, element) => scrollOf(element, 'left', num));
        }

        contains(target) {
            const root = this.get();
            const children = nodes(target);
            return Boolean(root?.contains && children.some(child => root !== child && root.contains(child)));
        }

        offsetParent() {
            return this._push(this.elements.map(element => element.offsetParent).filter(Boolean));
        }

        serializeJSON() {
            const result = Object.create(null);
            for (const { name, value } of this.serializeArray()) {
                if (Object.hasOwn(result, name)) {
                    if (!Array.isArray(result[name])) result[name] = [result[name]];
                    result[name].push(value);
                } else result[name] = value;
            }
            return result;
        }

        reset() {
            return this.each((i, element) => {
                if (element instanceof global.HTMLFormElement) element.reset();
            });
        }

        // Observe children added/removed under each selected root.
        // Callback receives { added, removed, records, root }.
        observeMutations(callback, options = {}) {
            if (typeof callback !== 'function') throw new TypeError('Callback required');
            if (!global.MutationObserver) throw new Error('MutationObserver unavailable');
            return this.each((i, root) => {
                if (!root?.nodeType) return;
                let entries = mutationMemory.get(root);
                if (entries?.has(callback)) return;
                const observer = new global.MutationObserver(records => {
                    // A queued notification may outlive explicit unsubscribe
                    // or destructive removal. Never deliver stale callbacks.
                    if (mutationMemory.get(root)?.get(callback) !== observer) return;
                    const added = [], removed = [];
                    for (const record of records) {
                        for (const node of record.addedNodes) added.push(node);
                        for (const node of record.removedNodes) removed.push(node);
                    }
                    callback.call(root, { added, removed, records, root });
                });
                // Native observe() validates options and may throw. Only save
                // a subscription once observation actually succeeds.
                observer.observe(root, {
                    childList: true, subtree: true, ...options
                });
                if (!entries) { entries = new Map(); mutationMemory.set(root, entries); }
                entries.set(callback, observer);
            });
        }

        unobserveMutations(callback) {
            return this.each((i, root) => {
                const entries = mutationMemory.get(root);
                if (!entries) return;
                for (const [fn, observer] of entries) {
                    if (callback === undefined || callback === fn) {
                        entries.delete(fn);
                        try { observer.disconnect(); }
                        catch (_) { /* do not retain a stale subscription */ }
                    }
                }
                if (!entries.size) mutationMemory.delete(root);
            });
        }

        fadeIn(duration = 200) {
            return this._fade(true, duration);
        }

        fadeOut(duration = 200) {
            return this._fade(false, duration);
        }

        _fade(show, duration) {
            if (!Number.isFinite(duration) || duration < 0) throw new TypeError('Invalid duration');
            return this.each((i, element) => {
                if (!element?.style) return;
                const previous = fadeMemory.get(element);
                if (previous) {
                    // Drop the old animation before cancellation: a patched
                    // cancel() may throw or synchronously fire callbacks.
                    fadeMemory.delete(element);
                    try { previous.cancel(); }
                    catch (_) { /* a failed cancellation must not block replacement */ }
                }
                if (show) new Collection([element]).show();
                if (!element.animate || duration === 0) {
                    if (!show) new Collection([element]).hide();
                    return;
                }
                const from = show ? 0 : Number(global.getComputedStyle(element).opacity) || 1;
                const to = show ? 1 : 0;
                const animation = element.animate([{ opacity: from }, { opacity: to }],
                    { duration, easing: 'ease', fill: 'none' });
                fadeMemory.set(element, animation);
                animation.onfinish = () => {
                    if (fadeMemory.get(element) !== animation) return;
                    fadeMemory.delete(element);
                    if (!show) new Collection([element]).hide();
                };
                animation.oncancel = () => {
                    if (fadeMemory.get(element) === animation) fadeMemory.delete(element);
                };
            });
        }

        // Document coordinates, including the current page scroll.
        offset(value) {
            if (value !== undefined) return this.each((i, element) => {
                const next = typeof value === 'function' ? value.call(element, i, new Collection([element]).offset()) : value;
                if (!next || !element.style) return;
                const style = global.getComputedStyle(element);
                if (style.position === 'static') element.style.position = 'relative';
                const current = new Collection([element]).offset();
                for (const axis of ['top', 'left']) {
                    if (next[axis] == null) continue;
                    const old = parseFloat(global.getComputedStyle(element)[axis]);
                    element.style[axis] = ((Number.isFinite(old) ? old : 0) + next[axis] - current[axis]) + 'px';
                }
            });
            const element = this.get();
            if (!element || typeof element.getBoundingClientRect !== 'function') return undefined;
            const rect = element.getBoundingClientRect();
            return { top: rect.top + global.scrollY, left: rect.left + global.scrollX };
        }

        // Coordinates relative to the offset parent padding edge.
        position() {
            const element = this.get();
            if (!element || element.nodeType !== 1) return undefined;
            const style = global.getComputedStyle(element);
            if (style.position === 'fixed') {
                const rect = element.getBoundingClientRect();
                return { top: rect.top - parseFloat(style.marginTop || 0),
                    left: rect.left - parseFloat(style.marginLeft || 0) };
            }
            const parent = element.offsetParent;
            const rect = element.getBoundingClientRect();
            const parentRect = parent ? parent.getBoundingClientRect() : { top: 0, left: 0 };
            return {
                top: rect.top - parentRect.top - (parent?.clientTop || 0) +
                    (parent?.scrollTop || 0) - (parseFloat(style.marginTop) || 0),
                left: rect.left - parentRect.left - (parent?.clientLeft || 0) +
                    (parent?.scrollLeft || 0) - (parseFloat(style.marginLeft) || 0)
            };
        }

        // Whether an element currently occupies rendered layout boxes.
        // Does not imply it is inside the viewport or unobscured.
        isVisible() {
            const element = this.get();
            if (!element || element.nodeType !== 1 || !element.isConnected) return false;
            const style = global.getComputedStyle(element);
            return style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
                element.getClientRects().length > 0;
        }

        focus(options) {
            return this.each((i, element) => element.focus?.(options));
        }

        blur() {
            return this.each((i, element) => element?.blur?.());
        }

        scrollIntoView(options) {
            return this.each((i, element) => element?.scrollIntoView?.(options));
        }

        toggle(force) {
            if (force !== undefined && typeof force !== 'boolean') {
                throw new TypeError('toggle() requires a boolean or no argument');
            }
            return this.each((i, element) => {
                const wrapper = new Collection([element]);
                if (force === true) wrapper.show();
                else if (force === false || wrapper.isVisible()) wrapper.hide();
                else wrapper.show();
            });
        }

        slice(start, end) {
            return this._push(this.elements.slice(start, end));
        }

        // Observe content-box dimensions for each selected HTML/SVG element.
        // Callback `this` is the element, with (width, height, nativeEntry).
        // ResizeObserver fires asynchronously, including an initial reading.
        // Repeating the same callback on one element does not duplicate it.
        observeResize(callback) {
            if (typeof callback !== 'function') {
                throw new TypeError('observeResize() requires a callback function');
            }
            if (!this.length) return this;
            // Validate the complete selection before registering anything, so
            // an invalid target cannot leave partial subscriptions behind.
            const elements = [...new Set(this.elements.filter(element => element != null))];
            for (const element of elements) {
                if (element.nodeType !== 1) {
                    throw new TypeError('observeResize() requires Element nodes (not window/document)');
                }
            }
            if (!elements.length) return this;
            getResizeObserver();
            for (const element of elements) addResizeListener(element, callback);
            return this;
        }

        // Without callback, stop all resize subscriptions for the selection.
        // Destructive DOM methods automatically unsubscribe descendants.
        unobserveResize(callback) {
            if (callback !== undefined && typeof callback !== 'function') {
                throw new TypeError('unobserveResize() requires a function or no argument');
            }
            for (const element of new Set(this.elements)) {
                if (element != null && (typeof element === 'object' || typeof element === 'function')) {
                    removeResizeListeners(element, callback);
                }
            }
            return this;
        }

        // Direct: .on('click', handler[, options])
        // Delegated: .on('click', '.child', handler[, options])
        on(events, selector, handler, options) {
            if (events && typeof events === 'object') {
                for (const [type, fn] of Object.entries(events)) this.on(type, selector, fn, handler);
                return this;
            }
            return bindEvents(this, events, selector, handler, options, false);
        }

        // Like on(), but removes the listener after its first matching event.
        one(events, selector, handler, options) {
            return bindEvents(this, events, selector, handler, options, true);
        }

        // .off('.posts') removes only namespaced listeners.
        // Repeated .on() registrations with the same callback/selector/type/
        // namespace/capture are automatically deduplicated.
        off(events, selector, handler) {
            if (events && typeof events === 'object' && events.handleObj) {
                const info = events.handleObj;
                // Remove only the exact registration which dispatched this event.
                // A callback may also be registered under other namespaces,
                // capture modes or AbortSignals on the same element.
                if (info._record) return this.each((i, element) => {
                    // Manually assembled collections can contain nulls or
                    // primitives; only event targets can own registrations.
                    if (!element || (typeof element !== 'object' && typeof element !== 'function')) return;
                    if ((eventMemory.get(element) || []).includes(info._record))
                        unbindRecord(element, info._record);
                });
                return this.off(info.type + (info.namespace ? '.' + info.namespace : ''),
                    info.selector, info.handler);
            }
            if (typeof selector === 'function') {
                handler = selector;
                selector = undefined;
            }
            const tokens = events == null ? null : eventTokens(events);
            return this.each((i, element) => {
                if (!element || (typeof element !== 'object' && typeof element !== 'function')) return;
                const records = [...(eventMemory.get(element) || [])];
                for (const record of records) {
                    if ((!tokens || tokens.some(token => matchesToken(record, token))) &&
                        (selector === undefined || selector === record.selector) &&
                        (handler === undefined || handler === record.handler)) {
                        unbindRecord(element, record);
                    }
                }
            });
        }

        // Invoke MiniDOM handlers on the first selected node without bubbling.
        // Unlike jQuery, this returns the last callback result (if any).
        triggerHandler(eventName, detail) {
            const element = this.get();
            if (element == null || (typeof element !== 'object' && typeof element !== 'function')) return undefined;
            const token = eventTokens(eventName)[0];
            if (!token || !token.type) throw new TypeError('Event type required');
            let result;
            const event = new global.CustomEvent(token.type, { detail, cancelable: true });
            // triggerHandler invokes callbacks directly (without native dispatch),
            // so emulate immediate-propagation cancellation for this loop.
            let immediateStopped = false;
            const nativeStopImmediate = event.stopImmediatePropagation.bind(event);
            event.stopImmediatePropagation = () => {
                immediateStopped = true;
                nativeStopImmediate();
            };
            for (const record of [...(eventMemory.get(element) || [])]) {
                if (immediateStopped) break;
                if (!matchesToken(record, token) || record.selector !== null) continue;
                // A previous handler can remove another handler while we iterate.
                // Do not invoke records that have already been unbound.
                if (!(eventMemory.get(element) || []).includes(record)) continue;
                if (record.once) unbindRecord(element, record);
                // Do not leak event.data from a preceding handler.
                event.data = record.eventData;
                event.delegateTarget = element;
                event.handleObj = { type: record.type, selector: null, handler: record.handler,
                    namespace: record.namespaces.join('.'), _record: record };
                result = record.handler.call(element, event);
                // Match the native .on()/.one() return-false convention.
                // There is no bubbling in triggerHandler(), but expose the
                // same cancellation state to subsequent direct callbacks.
                if (result === false) {
                    event.preventDefault();
                    event.stopPropagation();
                }
            }
            return result;
        }
        hover(enter, leave = enter) {
            return this.on('mouseenter', enter).on('mouseleave', leave);
        }

        // Dispatch native bubbling events. Namespaces on trigger() are
        // deliberately not supported: use the base event type.
        trigger(events, detail) {
            const tokens = eventTokens(events);
            if (tokens.some(token => !token.type || token.namespaces.length)) {
                throw new TypeError('trigger() requires unnamespaced event types');
            }
            return this.each((i, element) => {
                if (!element?.dispatchEvent) return;
                for (const token of tokens) {
                    const options = { bubbles: true, cancelable: true };
                    const event = detail === undefined
                        ? new global.Event(token.type, options)
                        : new global.CustomEvent(token.type, { ...options, detail });
                    element.dispatchEvent(event);
                }
            });
        }

        ready(callback) {
            ready(callback);
            return this;
        }

        // Properties are native JS values, unlike string-only attributes.
        prop(name, value) {
            if (name && typeof name === 'object') {
                return this.each((i, element) => {
                    if (element == null) return;
                    for (const [key, val] of Object.entries(name)) {
                        if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
                        element[key] = typeof val === 'function' ? val.call(element, i, element[key]) : val;
                    }
                });
            }
            if (value === undefined) return this.get()?.[name];
            if (name === '__proto__' || name === 'prototype' || name === 'constructor') return this;
            return this.each((i, element) => {
                if (element == null) return;
                element[name] = typeof value === 'function' ? value.call(element, i, element[name]) : value;
            });
        }

        // .data(key) reads a cached value or parses a data-* attribute.
        // .data(key, value) stores in memory without changing the DOM attribute.
        data(key, value) {
            if (key === undefined) {
                const element = this.get();
                if (element == null || (typeof element !== 'object' && typeof element !== 'function')) return undefined;
                const result = Object.create(null);
                for (const attr of element.attributes || []) {
                    if (attr.name.startsWith('data-')) {
                        const name = dataKey(attr.name.slice(5));
                        result[name] = readData(element, name);
                    }
                }
                return Object.assign(result, dataMemory.get(element) || {});
            }
            if (key !== null && typeof key === 'object') {
                return this.each((i, element) => {
                    if (element == null || (typeof element !== 'object' && typeof element !== 'function')) return;
                    const cache = cachedData(element);
                    for (const [name, val] of Object.entries(key)) cache[dataKey(name)] = val;
                });
            }
            if (value === undefined) return readData(this.get(), key);
            return this.each((i, element) => {
                if (element == null || (typeof element !== 'object' && typeof element !== 'function')) return;
                cachedData(element)[dataKey(key)] = value;
            });
        }

        removeData(key) {
            return this.each((i, element) => {
                if (element == null || (typeof element !== 'object' && typeof element !== 'function')) return;
                if (key === undefined) {
                    dataMemory.delete(element);
                } else {
                    const cache = dataMemory.get(element);
                    if (!cache) return;
                    for (const name of String(key).trim().split(/\s+/).filter(Boolean)) {
                        delete cache[dataKey(name)];
                    }
                }
            });
        }

        // Manipulation methods mutate the current selection and return it.
        // HTML strings are parsed by the browser: never pass untrusted HTML.
        // Functional insertion callbacks run once per distinct destination.
        // Keep the first original collection index for callback compatibility.
        _insertContent(content, position) {
            if (content.some(item => typeof item === 'function')) {
                const seen = new Set();
                this.elements.forEach((el, i) => {
                    if (!isNode(el) || seen.has(el)) return;
                    seen.add(el);
                    // A sibling insertion requires an attached parent. Do not
                    // execute callbacks for destinations that cannot be used.
                    if ((position === 'before' || position === 'after') && !el.parentNode) return;
                    const values = content.map(item => typeof item === 'function'
                        ? item.call(el, i, el.innerHTML) : item);
                    insertNodes([el], values.flatMap(contentNodes), position);
                });
            } else {
                insertNodes(this.elements, content.flatMap(contentNodes), position);
            }
            return this;
        }

        append(...content) { return this._insertContent(content, 'append'); }
        prepend(...content) { return this._insertContent(content, 'prepend'); }
        before(...content) { return this._insertContent(content, 'before'); }
        after(...content) { return this._insertContent(content, 'after'); }

        // These return the inserted selection (which may include clones),
        // so .end() returns to the original source selection.
        appendTo(target) {
            return this._push(insertNodes(select(target), this.elements, 'append'));
        }

        prependTo(target) {
            return this._push(insertNodes(select(target), this.elements, 'prepend'));
        }

        insertBefore(target) { return this._push(insertNodes(select(target), this.elements, 'before')); }
        insertAfter(target) { return this._push(insertNodes(select(target), this.elements, 'after')); }
        replaceAll(target) {
            // A source selection may contain an ancestor and its descendants.
            // Moving both independently would flatten the source subtree.
            const sources = topLevelNodes(this.elements.filter(isNode));
            const targets = replacementTargets([...select(target)], sources);
            const inserted = [];
            targets.forEach((node, i) => {
                const copies = i === targets.length - 1 ? sources :
                    sources.map(source => cloneNodeWithState(source, true));
                // Use a fragment: spreading tens of thousands of nodes as
                // function arguments can throw RangeError in browsers.
                const fragment = node.ownerDocument.createDocumentFragment();
                for (const copy of copies) fragment.appendChild(copy);
                node.replaceWith(fragment);
                cleanTree(node);
                for (const copy of copies) inserted.push(copy);
            });
            return this._push(inserted);
        }
        // A <template> wrapper stores its actual children in .content.
        // Appending to the element itself creates inaccessible light-DOM
        // children instead of the intended inert template contents.
        _wrapperDestination(wrapper) {
            let deepest = wrapper;
            while (deepest.firstElementChild) deepest = deepest.firstElementChild;
            return deepest.localName === 'template' &&
                deepest.namespaceURI === 'http://www.w3.org/1999/xhtml'
                ? deepest.content : deepest;
        }
        wrapAll(content) {
            // Deduplicate selections and keep only top-level elements. A
            // repeated element must not be moved to the end of its own
            // wrapper, and a selected descendant travels with its ancestor.
            // Never move a document's structural roots into a wrapper. Such
            // moves can corrupt the document tree (including foreign documents).
            const elements = topLevelNodes(this.elements.filter(element =>
                element && element.nodeType === 1 && element.parentNode &&
                element !== element.ownerDocument?.documentElement &&
                element !== element.ownerDocument?.body));
            if (!elements.length) return this;
            // Like jQuery, a functional wrapper is evaluated once using the
            // first eligible element's index and existing HTML.
            const first = elements[0];
            const index = this.elements.indexOf(first);
            const supplied = typeof content === 'function'
                ? content.call(first, index, first.innerHTML) : content;
            const template = contentNodes(supplied).find(node => node.nodeType === 1);
            if (!template) return this;
            const wrapper = cloneNodeWithState(template, true);
            elements[0].before(wrapper);
            const destination = this._wrapperDestination(wrapper);
            for (const element of elements) destination.appendChild(element);
            return this;
        }
        wrapInner(content) {
            // Static content can be parsed once; functional content is
            // evaluated separately for each eligible, distinct destination.
            const staticTemplate = typeof content === 'function' ? null :
                contentNodes(content).find(node => node.nodeType === 1);
            if (typeof content !== 'function' && !staticTemplate) return this;
            // A repeated destination should not receive another wrapper.
            // Keep the first occurrence's index and preserve collection chaining.
            const seen = new Set();
            return this.each((i, element) => {
                if (seen.has(element)) return;
                seen.add(element);
                // The document element contains <head> and <body>; moving
                // either inside an arbitrary wrapper corrupts HTML structure.
                // Check validity before cloning any managed wrapper state.
                if (!element || (element.nodeType !== 1 && element.nodeType !== 11) ||
                    element === element.ownerDocument?.documentElement) return;
                const supplied = typeof content === 'function'
                    ? content.call(element, i, element.innerHTML) : null;
                const template = typeof content === 'function'
                    ? contentNodes(supplied).find(node => node.nodeType === 1)
                    : staticTemplate;
                if (!template) return;
                const wrapper = cloneNodeWithState(template, true);
                const destination = this._wrapperDestination(wrapper);
                // Template descendants live in .content, not element.childNodes.
                const target = element.nodeType === 1 && element.localName === 'template' &&
                    element.namespaceURI === 'http://www.w3.org/1999/xhtml'
                    ? element.content : element;
                while (target.firstChild) destination.appendChild(target.firstChild);
                target.append(wrapper);
            });
        }
        removeProp(name) {
            // Match prop()'s prototype-key protection and tolerate sparse or
            // mixed collections, including null and undefined entries.
            if (name === '__proto__' || name === 'constructor' || name === 'prototype') return this;
            return this.each((i, element) => {
                if (element == null) return;
                try { delete element[name]; } catch (_) { /* native nonconfigurable property */ }
            });
        }

        // .clone() copies DOM only; .clone(true) copies managed events/data
        // on the node and descendants; .clone(true, false) copies root only.
        clone(withDataAndEvents = false, deepWithDataAndEvents = withDataAndEvents) {
            return this._push(this.elements.filter(element => isNode(element))
                .map(element => cloneNodeWithState(element, withDataAndEvents, deepWithDataAndEvents)));
        }

        // Detach preserves MiniDOM state. Append/prepend can reattach later.
        detach() {
            // A collection may contain both an ancestor and its descendants.
            // Detaching each entry independently would pull children out of the
            // detached parent. Move only the top-level selected nodes; keep
            // the original collection and all managed state intact.
            for (const element of removalRoots(this.elements.filter(isNode))) {
                if (element.nodeType !== 9) element.parentNode?.removeChild(element);
            }
            return this;
        }

        empty() {
            // A selected descendant must not be emptied a second time after
            // its ancestor has already removed it. Preserve detached subtree
            // structure while cleaning managed state from removed children.
            const eligible = this.elements.filter(element =>
                isNode(element) && element.nodeType !== 9 && element.replaceChildren);
            // Template content is a DocumentFragment without a parentNode
            // link to its host. Index selected template contents once rather
            // than scanning the entire selection for every ancestor fragment.
            const selectedTemplateContents = new Set(eligible
                .filter(element => element.nodeType === 1 &&
                    element.localName === 'template' &&
                    element.namespaceURI === 'http://www.w3.org/1999/xhtml')
                .map(element => element.content));
            const roots = topLevelNodes(eligible).filter(element => {
                for (let parent = element.parentNode; parent; parent = parent.parentNode) {
                    if (selectedTemplateContents.has(parent)) return false;
                }
                return true;
            });
            for (const element of roots) {
                const target = element.localName === 'template' &&
                    element.namespaceURI === 'http://www.w3.org/1999/xhtml'
                    ? element.content : element;
                cleanChildren(target);
                target.replaceChildren();
            }
            return this;
        }

        remove() {
            // Removing an ancestor already removes its descendants. Avoid
            // subsequently detaching selected children from the removed tree,
            // which would unexpectedly alter the caller's detached subtree.
            // Clean managed state once per top-level removed subtree.
            const roots = removalRoots(this.elements.filter(element =>
                isNode(element) && element.nodeType !== 9));
            for (const element of roots) {
                cleanTree(element);
                element.parentNode?.removeChild(element);
            }
            return this;
        }

        replaceWith(...content) {
            const flattened = content.flatMap(contentNodes);
            // Moving a selected parent already moves its descendants. Inserting
            // both would detach the descendants and flatten the source tree.
            const source = topLevelNodes(flattened);
            const validTargets = replacementTargets(this.elements, source);
            validTargets.forEach((element, index) => {
                const copies = index === validTargets.length - 1
                    ? source
                    : source.map(node => cloneNodeWithState(node, true));
                // Build replacement nodes in the receiving document, not the
                // global document (which may differ for iframe/foreign targets).
                const fragment = element.ownerDocument.createDocumentFragment();
                for (const copy of copies) fragment.appendChild(copy);
                element.parentNode.replaceChild(fragment, element);
                // Any children moved out of the old element remain live.
                cleanTree(element);
            });
            return this;
        }

        // Wrap each element with a copy of the first wrapper element.
        // Content can be trusted HTML or a native/MiniDOM element.
        wrap(content) {
            const staticTemplate = typeof content === 'function' ? null :
                contentNodes(content).find(node => node.nodeType === 1);
            if (typeof content !== 'function' && !staticTemplate) return this;
            // Wrap each distinct element once, even if the collection repeats it.
            const seen = new Set();
            return this.each((i, element) => {
                if (seen.has(element)) return;
                seen.add(element);
                if (!element || !element.parentNode || element.nodeType !== 1 ||
                    element === element.ownerDocument?.documentElement ||
                    element === element.ownerDocument?.body) return;
                const supplied = typeof content === 'function'
                    ? content.call(element, i, element.innerHTML) : null;
                const template = typeof content === 'function'
                    ? contentNodes(supplied).find(node => node.nodeType === 1)
                    : staticTemplate;
                if (!template) return;
                const outer = cloneNodeWithState(template, true);
                element.parentNode.insertBefore(outer, element);
                this._wrapperDestination(outer).appendChild(element);
            });
        }

        // Remove each distinct direct parent, keeping its children and their
        // managed event/data state. Never unwrap <html> or <body>.
        unwrap() {
            // Guard structural roots in their own document, not only the
            // document that loaded MiniDOM. Collections can contain nodes
            // from DOMParser, iframes, or document.implementation documents.
            const parents = unique(this.elements.map(element => element?.parentElement))
                .filter(parent => parent && parent.parentNode &&
                    parent !== parent.ownerDocument.body &&
                    parent !== parent.ownerDocument.documentElement);
            // Process nested wrappers from the inside out. This keeps the
            // operation independent of selection order and avoids moving an
            // inner wrapper twice before its own children are unwrapped.
            const selectedParents = new Set(parents);
            const depth = parent => {
                let count = 0;
                for (let ancestor = parent.parentNode; ancestor; ancestor = ancestor.parentNode) {
                    if (selectedParents.has(ancestor)) count++;
                }
                return count;
            };
            parents.sort((a, b) => depth(b) - depth(a));
            for (const parent of parents) {
                const fragment = parent.ownerDocument.createDocumentFragment();
                while (parent.firstChild) fragment.appendChild(parent.firstChild);
                parent.replaceWith(fragment);
                cleanNode(parent);
            }
            return this;
        }
    }

    function MiniDOM(selector, context) {
        if (typeof selector === 'function') {
            ready(selector);
            return new Collection([global.document]);
        }
        return new Collection(select(selector, context));
    }

    MiniDOM.version = VERSION;
    MiniDOM.fn = Collection.prototype;
    MiniDOM.noConflict = function () {
        if (global.$ === MiniDOM) global.$ = previousDollar;
        return MiniDOM;
    };

    global.MiniDOM = MiniDOM;
    global.$ = MiniDOM;
})(window);
