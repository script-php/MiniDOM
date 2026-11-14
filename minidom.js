/* MiniDOM v0.0.13 — small, chainable DOM helper. No dependencies. */
(function (global) {
    'use strict';

    const VERSION = '0.0.13';
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
        if (typeof value !== 'string') return nodes(value);

        // jQuery-style element creation. Only markup-shaped strings are parsed;
        // ordinary strings remain CSS selectors. Do NOT interpolate untrusted
        // data into HTML strings: use .text() / .val() for user input.
        const trimmed = value.trim();
        if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
            const template = global.document.createElement('template');
            template.innerHTML = trimmed;
            const created = [...template.content.childNodes];
            for (const node of created) template.content.removeChild(node);
            return created;
        }

        // A context can itself be a CSS selector, node, or MiniDOM collection.
        const roots = context === undefined
            ? [global.document]
            : typeof context === 'string'
                ? global.document.querySelectorAll(context)
                : nodes(context);

        // The constructor deduplicates once; avoid extra sets and temporary
        // arrays when there is only one root (the common case).
        if (roots.length === 1) {
            const root = roots[0];
            return root && typeof root.querySelectorAll === 'function'
                ? root.querySelectorAll(value)
                : [];
        }

        const found = [];
        for (const root of roots) {
            if (root && typeof root.querySelectorAll === 'function') {
                for (const element of root.querySelectorAll(value)) found.push(element);
            }
        }
        return found;
    }

    function classes(value) {
        return String(value).trim().split(/\s+/).filter(Boolean);
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
        if (!element) return undefined;
        const cache = cachedData(element);
        const normalized = dataKey(key);
        if (Object.hasOwn(cache, normalized)) return cache[normalized];
        if (!element.getAttribute) return undefined;
        const attr = element.getAttribute(dataAttr(normalized));
        if (attr === null) return undefined;
        return (cache[normalized] = parseData(attr));
    }

    function unbindRecord(element, record) {
        element.removeEventListener(record.type, record.wrapped, record.options);
        // AbortSignal listeners must not outlive an unbound event listener.
        if (record.signal && record.abortHandler) {
            record.signal.removeEventListener('abort', record.abortHandler);
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
        const capture = typeof nativeOptions === 'boolean' ? nativeOptions : Boolean(nativeOptions?.capture);

        return collection.each((i, element) => {
            if (!element.addEventListener || signal?.aborted) return;
            for (const token of tokens) {
                const records = eventMemory.get(element) || [];
                // The same callback, selector, type, namespaces and capture mode
                // is registered only once on an element.
                if (records.some(record =>
                    record.type === token.type && record.handler === handler &&
                    record.selector === selector && record.capture === capture &&
                    record.namespaces.join('.') === token.namespaces.join('.'))) continue;
                const record = {
                    type: token.type, namespaces: token.namespaces, selector, handler,
                    options: nativeOptions, capture, once: removeOnce,
                    wrapped: null, signal, abortHandler: null
                };
                record.wrapped = function (event) {
                    let context = element;
                    if (selector !== null) {
                        const target = event.target?.nodeType === 1
                            ? event.target : event.target?.parentElement;
                        const match = target?.closest(selector);
                        if (!match || match === element || !element.contains?.(match)) return;
                        context = match;
                    }
                    if (removeOnce) unbindRecord(element, record);
                    handler.call(context, event);
                };
                element.addEventListener(token.type, record.wrapped, nativeOptions);
                records.push(record);
                eventMemory.set(element, records);
                if (signal) {
                    record.abortHandler = () => unbindRecord(element, record);
                    signal.addEventListener('abort', record.abortHandler, { once: true });
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
            callbacks = new Set();
            resizeMemory.set(element, callbacks);
            getResizeObserver().observe(element);
        }
        callbacks.add(callback);
    }

    function removeResizeListeners(element, callback) {
        const callbacks = resizeMemory.get(element);
        if (!callbacks) return;
        if (callback === undefined) callbacks.clear();
        else callbacks.delete(callback);
        if (!callbacks.size) {
            sharedResizeObserver?.unobserve(element);
            resizeMemory.delete(element);
        }
    }

    // MiniDOM stores events, data, display, and resize listeners in WeakMaps.
    // Detaching a node leaves them intact; destructive removals clean the
    // entire subtree (including text nodes with MiniDOM listeners).
    function cleanNode(node) {
        for (const record of [...(eventMemory.get(node) || [])]) unbindRecord(node, record);
        dataMemory.delete(node);
        displayMemory.delete(node);
        removeResizeListeners(node);
        const observers = mutationMemory.get(node);
        if (observers) {
            for (const observer of observers.values()) observer.disconnect();
            mutationMemory.delete(node);
        }
        const animation = fadeMemory.get(node);
        if (animation) { animation.cancel(); fadeMemory.delete(node); }
    }

    function cleanTree(node) {
        if (!node) return;
        for (const child of [...(node.childNodes || [])]) cleanTree(child);
        cleanNode(node);
    }

    function cleanChildren(node) {
        for (const child of [...(node.childNodes || [])]) cleanTree(child);
    }

    // Copy user data without accidentally sharing ordinary nested objects.
    // Cycles and common built-in structured values are supported. Functions,
    // DOM nodes and non-plain class instances retain their identity.
    function copyDataValue(value, seen = new WeakMap()) {
        if (value === null || typeof value !== 'object') return value;
        if (isNode(value)) return value;
        if (seen.has(value)) return seen.get(value);
        if (Array.isArray(value)) {
            const result = [];
            seen.set(value, result);
            for (const item of value) result.push(copyDataValue(item, seen));
            return result;
        }
        if (value instanceof Date) return new Date(value.getTime());
        if (value instanceof RegExp) return new RegExp(value.source, value.flags);
        if (value instanceof Map) {
            const result = new Map();
            seen.set(value, result);
            for (const [key, val] of value) result.set(copyDataValue(key, seen), copyDataValue(val, seen));
            return result;
        }
        if (value instanceof Set) {
            const result = new Set();
            seen.set(value, result);
            for (const item of value) result.add(copyDataValue(item, seen));
            return result;
        }
        if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
            const result = Object.create(Object.getPrototypeOf(value));
            seen.set(value, result);
            for (const key of Object.keys(value)) result[key] = copyDataValue(value[key], seen);
            return result;
        }
        return value;
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
                record.handler, record.options, record.once);
        }
    }

    function cloneNodeWithState(source, copyState = false, deepState = copyState) {
        const cloned = source.cloneNode(true);
        if (copyState) copyManagedState(source, cloned);
        if (deepState) {
            // A pairwise walk handles elements, text, comments and fragments.
            const walk = (from, to) => {
                for (let i = 0; i < from.childNodes.length; i++) {
                    const fromChild = from.childNodes[i];
                    const toChild = to.childNodes[i];
                    copyManagedState(fromChild, toChild);
                    walk(fromChild, toChild);
                }
            };
            walk(source, cloned);
        }
        return cloned;
    }

    // An insertion accepts HTML/text, native nodes, MiniDOM selections, and
    // (possibly nested) iterables of these. Raw HTML must be trusted.
    function contentNodes(value) {
        if (value == null) return [];
        if (typeof value === 'string') {
            const template = global.document.createElement('template');
            template.innerHTML = value;
            return [...template.content.childNodes];
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
            return [global.document.createTextNode(String(value))];
        }
        if (value instanceof Collection) return value.elements.flatMap(contentNodes);
        if (isNode(value)) return value.nodeType === 11 ? [...value.childNodes] : [value];
        if (typeof value[Symbol.iterator] === 'function') {
            return [...value].flatMap(contentNodes);
        }
        return [];
    }

    // For multiple destinations: clone for all but the final destination;
    // move original source nodes into the last. Preserve insertion order.
    function insertNodes(destinations, source, position) {
        const targets = Array.from(destinations).filter(target =>
            (position === 'before' || position === 'after')
                ? Boolean(target.parentNode && target.before && target.after)
                : Boolean(target.append && target.prepend)
        );
        const inserted = [];
        // Avoid creating a DocumentFragment for the most common case: one
        // destination and one source node. The native insertion moves the node.
        if (targets.length === 1 && source.length === 1) {
            targets[0][position](source[0]);
            return [source[0]];
        }
        targets.forEach((target, index) => {
            const copies = index === targets.length - 1
                ? source
                : source.map(node => cloneNodeWithState(node, true));
            if (!copies.length) return;
            const fragment = global.document.createDocumentFragment();
            fragment.append(...copies);
            target[position](fragment);
            inserted.push(...copies);
        });
        return inserted;
    }

    // Compile once per traversal, not once per element. For a node-list or
    // Collection selector this avoids materializing the same list N times.
    function matcher(selector) {
        if (typeof selector === 'function') {
            return (element, index) => Boolean(selector.call(element, index, element));
        }
        if (typeof selector === 'string') {
            return element => typeof element.matches === 'function' && element.matches(selector);
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
            // Collect directly instead of creating an array per root via
            // flatMap + spread. _push() still removes overlapping duplicates.
            const found = [];
            for (const element of this.elements) {
                if (typeof element.querySelectorAll !== 'function') continue;
                for (const child of element.querySelectorAll(selector)) found.push(child);
            }
            return this._push(found);
        }

        parent(selector) {
            const found = [];
            for (const element of this.elements) {
                const parent = element.parentElement;
                if (parent && (!selector || parent.matches(selector))) found.push(parent);
            }
            return this._push(found);
        }

        children(selector) {
            const found = [];
            for (const element of this.elements) {
                if (!element.children) continue;
                for (const child of element.children) {
                    if (!selector || child.matches(selector)) found.push(child);
                }
            }
            return this._push(found);
        }

        closest(selector) {
            const found = [];
            for (const element of this.elements) {
                if (typeof element.closest !== 'function') continue;
                const match = element.closest(selector);
                if (match) found.push(match);
            }
            return this._push(found);
        }

        filter(selector) {
            return this._push(this.elements.filter(matcher(selector)));
        }

        not(selector) {
            const matches = matcher(selector);
            return this._push(this.elements.filter((element, index) => !matches(element, index)));
        }

        is(selector) {
            return this.elements.some(matcher(selector));
        }

        // Keep only elements containing a matching descendant. Unlike find(),
        // this returns the outer elements and preserves .end() traversal.
        has(selector) {
            if (typeof selector === 'string') {
                return this._push(this.elements.filter(element => element.querySelector?.(selector)));
            }
            const targets = nodes(selector);
            return this._push(this.elements.filter(element =>
                typeof element.contains === 'function' &&
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
                if (!element.parentElement) continue;
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
                const sibling = element.nextElementSibling;
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
                const sibling = element.previousElementSibling;
                if (!sibling) continue;
                if (!matches || matches(sibling, index)) found.push(sibling);
                index++;
            }
            return this._push(found);
        }

        addClass(names) {
            return this.each((i, element) => {
                const next = typeof names === 'function'
                    ? names.call(element, i, element.className) : names;
                const tokens = classes(next);
                if (element.classList && tokens.length) element.classList.add(...tokens);
            });
        }

        removeClass(names) {
            const tokens = classes(names);
            return this.each((i, element) => {
                if (element.classList && tokens.length) element.classList.remove(...tokens);
            });
        }

        toggleClass(names, force) {
            return this.each((i, element) => {
                if (!element.classList) return;
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
                element.classList && element.classList.contains(name)
            );
        }

        text(value) {
            if (value === undefined) return this.get()?.textContent;
            return this.each((i, element) => {
                const next = typeof value === 'function' ? value.call(element, i, element.textContent) : value;
                cleanChildren(element);
                element.textContent = next == null ? '' : String(next);
            });
        }

        html(value) {
            if (value === undefined) return this.get()?.innerHTML;
            return this.each((i, element) => {
                if ('innerHTML' in element) {
                    const next = typeof value === 'function' ? value.call(element, i, element.innerHTML) : value;
                    cleanChildren(element);
                    // As with .append(), only pass trusted markup here.
                    element.innerHTML = next == null ? '' : String(next);
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
            if (value === undefined) return this.get()?.getAttribute?.(name);
            return this.each((i, element) => {
                if (!element.setAttribute) return;
                if (value === null) element.removeAttribute(name);
                else element.setAttribute(name, String(value));
            });
        }

        removeAttr(name) {
            const names = String(name).trim().split(/\s+/).filter(Boolean);
            return this.each((i, element) => {
                for (const attr of names) element.removeAttribute?.(attr);
            });
        }

        css(property, value) {
            if (property && typeof property === 'object') {
                return this.each((i, element) => {
                    if (!element.style) return;
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
                    if (!element.style) return;
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
                if (!element.style) return;
                const computed = typeof value === 'function'
                    ? value.call(element, i, global.getComputedStyle(element).getPropertyValue(key))
                    : value;
                if (computed == null) element.style.removeProperty(key);
                else element.style.setProperty(key, String(computed));
            });
        }

        hide() {
            return this.each((i, element) => {
                if (!element.style) return;
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
                if (!element.style) return;
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
                if (!element.style) return;
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
        innerWidth() { return dimensionOf(this.get(), 'width', 'inner'); }
        innerHeight() { return dimensionOf(this.get(), 'height', 'inner'); }
        outerWidth(includeMargin = false) {
            return dimensionOf(this.get(), 'width', 'outer', Boolean(includeMargin));
        }
        outerHeight(includeMargin = false) {
            return dimensionOf(this.get(), 'height', 'outer', Boolean(includeMargin));
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
                if (!entries) { entries = new Map(); mutationMemory.set(root, entries); }
                if (entries.has(callback)) return;
                const observer = new global.MutationObserver(records => {
                    const added = [], removed = [];
                    for (const record of records) {
                        added.push(...record.addedNodes);
                        removed.push(...record.removedNodes);
                    }
                    callback.call(root, { added, removed, records, root });
                });
                observer.observe(root, {
                    childList: true, subtree: true, ...options
                });
                entries.set(callback, observer);
            });
        }

        unobserveMutations(callback) {
            return this.each((i, root) => {
                const entries = mutationMemory.get(root);
                if (!entries) return;
                for (const [fn, observer] of entries) {
                    if (callback === undefined || callback === fn) {
                        observer.disconnect();
                        entries.delete(fn);
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
                if (!element.style) return;
                const previous = fadeMemory.get(element);
                if (previous) previous.cancel();
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
        offset() {
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
            return this.each((i, element) => element.blur?.());
        }

        scrollIntoView(options) {
            return this.each((i, element) => element.scrollIntoView?.(options));
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
            for (const element of this.elements) {
                if (element.nodeType !== 1) {
                    throw new TypeError('observeResize() requires Element nodes (not window/document)');
                }
            }
            getResizeObserver();
            return this.each((i, element) => addResizeListener(element, callback));
        }

        // Without callback, stop all resize subscriptions for the selection.
        // Destructive DOM methods automatically unsubscribe descendants.
        unobserveResize(callback) {
            if (callback !== undefined && typeof callback !== 'function') {
                throw new TypeError('unobserveResize() requires a function or no argument');
            }
            return this.each((i, element) => removeResizeListeners(element, callback));
        }

        // Direct: .on('click', handler[, options])
        // Delegated: .on('click', '.child', handler[, options])
        on(events, selector, handler, options) {
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
            if (typeof selector === 'function') {
                handler = selector;
                selector = undefined;
            }
            const tokens = events == null ? null : eventTokens(events);
            return this.each((i, element) => {
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

        // Dispatch native bubbling events. Namespaces on trigger() are
        // deliberately not supported: use the base event type.
        trigger(events, detail) {
            const tokens = eventTokens(events);
            if (tokens.some(token => !token.type || token.namespaces.length)) {
                throw new TypeError('trigger() requires unnamespaced event types');
            }
            return this.each((i, element) => {
                if (!element.dispatchEvent) return;
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
                    for (const [key, val] of Object.entries(name)) element[key] = val;
                });
            }
            if (value === undefined) return this.get()?.[name];
            return this.each((i, element) => { element[name] = value; });
        }

        // .data(key) reads a cached value or parses a data-* attribute.
        // .data(key, value) stores in memory without changing the DOM attribute.
        data(key, value) {
            if (key === undefined) {
                const element = this.get();
                if (!element) return undefined;
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
                    const cache = cachedData(element);
                    for (const [name, val] of Object.entries(key)) cache[dataKey(name)] = val;
                });
            }
            if (value === undefined) return readData(this.get(), key);
            return this.each((i, element) => {
                cachedData(element)[dataKey(key)] = value;
            });
        }

        removeData(key) {
            return this.each((i, element) => {
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
        append(...content) {
            insertNodes(this.elements, content.flatMap(contentNodes), 'append');
            return this;
        }

        prepend(...content) {
            insertNodes(this.elements, content.flatMap(contentNodes), 'prepend');
            return this;
        }

        before(...content) {
            insertNodes(this.elements, content.flatMap(contentNodes), 'before');
            return this;
        }

        after(...content) {
            insertNodes(this.elements, content.flatMap(contentNodes), 'after');
            return this;
        }

        // These return the inserted selection (which may include clones),
        // so .end() returns to the original source selection.
        appendTo(target) {
            return this._push(insertNodes(select(target), this.elements, 'append'));
        }

        prependTo(target) {
            return this._push(insertNodes(select(target), this.elements, 'prepend'));
        }

        // .clone() copies DOM only; .clone(true) copies managed events/data
        // on the node and descendants; .clone(true, false) copies root only.
        clone(withDataAndEvents = false, deepWithDataAndEvents = withDataAndEvents) {
            return this._push(this.elements.filter(element => isNode(element))
                .map(element => cloneNodeWithState(element, withDataAndEvents, deepWithDataAndEvents)));
        }

        // Detach preserves MiniDOM state. Append/prepend can reattach later.
        detach() {
            return this.each((i, element) => element.parentNode?.removeChild(element));
        }

        empty() {
            return this.each((i, element) => {
                if (!element.replaceChildren) return;
                cleanChildren(element);
                element.replaceChildren();
            });
        }

        remove() {
            return this.each((i, element) => {
                cleanTree(element);
                element.parentNode?.removeChild(element);
            });
        }

        replaceWith(...content) {
            const targets = this.elements.filter(element => element.parentNode && isNode(element));
            const source = content.flatMap(contentNodes);
            targets.forEach((element, index) => {
                const copies = index === targets.length - 1
                    ? source
                    : source.map(node => cloneNodeWithState(node, true));
                const fragment = global.document.createDocumentFragment();
                fragment.append(...copies);
                element.parentNode.replaceChild(fragment, element);
                // Any children moved out of the old element remain live.
                cleanTree(element);
            });
            return this;
        }

        // Wrap each element with a copy of the first wrapper element.
        // Content can be trusted HTML or a native/MiniDOM element.
        wrap(content) {
            const template = contentNodes(content).find(node => node.nodeType === 1);
            if (!template) return this;
            return this.each((i, element) => {
                if (!element.parentNode || element.nodeType !== 1) return;
                const outer = cloneNodeWithState(template, true);
                element.parentNode.insertBefore(outer, element);
                let inner = outer;
                while (inner.firstElementChild) inner = inner.firstElementChild;
                inner.appendChild(element);
            });
        }

        // Remove each distinct direct parent, keeping its children and their
        // managed event/data state. Never unwrap <html> or <body>.
        unwrap() {
            const parents = unique(this.elements.map(element => element.parentElement))
                .filter(parent => parent && parent.parentNode &&
                    parent !== global.document.body && parent !== global.document.documentElement);
            for (const parent of parents) {
                parent.replaceWith(...[...parent.childNodes]);
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
