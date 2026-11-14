/* MiniDOM v0.0.4 — small, chainable DOM helper. No dependencies. */
(function (global) {
    'use strict';

    const VERSION = '0.0.4';
    const previousDollar = global.$;
    const displayMemory = new WeakMap();
    const eventMemory = new WeakMap();
    const dataMemory = new WeakMap();

    function isNode(value) {
        return value != null && typeof value.nodeType === 'number';
    }

    // One pass: remove duplicates while keeping the first-seen order.
    function unique(items) {
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

    function bindEvents(collection, events, selector, handler, options, once) {
        // .on('click', fn, options) or .on('click', '.child', fn, options)
        if (typeof selector === 'function') {
            options = handler;
            handler = selector;
            selector = null;
        }
        if (typeof handler !== 'function') throw new TypeError('Event handler must be a function');
        if (selector == null) selector = null;
        if (selector != null && typeof selector !== 'string') {
            throw new TypeError('Delegation selector must be a CSS selector string');
        }
        const types = splitEvents(events);
        const signal = options && typeof options === 'object' ? options.signal : null;
        const removeOnce = once || Boolean(options && typeof options === 'object' && options.once);
        // Handle `once` ourselves to keep bookkeeping in sync with native listeners.
        const nativeOptions = options && typeof options === 'object' && options.once
            ? { ...options, once: false }
            : options;

        return collection.each((i, element) => {
            if (!element.addEventListener || signal?.aborted) return;
            for (const type of types) {
                const record = {
                    type, selector, handler, options: nativeOptions,
                    wrapped: null, signal, abortHandler: null
                };
                record.wrapped = function (event) {
                    let context = element;
                    if (selector !== null) {
                        const target = event.target?.nodeType === 1
                            ? event.target : event.target?.parentElement;
                        const match = target?.closest(selector);
                        // Delegation applies to descendants, never the root itself.
                        if (!match || match === element || !element.contains?.(match)) return;
                        context = match;
                    }
                    // Remove before invoking, so reentrant triggers still run once.
                    if (removeOnce) unbindRecord(element, record);
                    handler.call(context, event);
                };
                element.addEventListener(type, record.wrapped, nativeOptions);
                const records = eventMemory.get(element) || [];
                records.push(record);
                eventMemory.set(element, records);

                // Native AbortSignal removal does not notify our event registry.
                if (signal) {
                    record.abortHandler = () => unbindRecord(element, record);
                    signal.addEventListener('abort', record.abortHandler, { once: true });
                    if (signal.aborted) unbindRecord(element, record);
                }
            }
        });
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
        if (value instanceof Collection) return [...value.elements];
        if (isNode(value)) return [value];
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
        targets.forEach((target, index) => {
            const copies = index === targets.length - 1
                ? source
                : source.map(node => node.cloneNode(true));
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

        first() { return this.eq(0); }
        last() { return this.eq(-1); }
        eq(index) { return this._push([this.get(index)]); }
        end() { return this.previous || new Collection([]); }

        find(selector) {
            return this._push(this.elements.flatMap(element =>
                typeof element.querySelectorAll === 'function'
                    ? [...element.querySelectorAll(selector)] : []
            ));
        }

        parent(selector) {
            return this._push(this.elements.map(element => element.parentElement)
                .filter(element => !selector || element?.matches(selector)));
        }

        children(selector) {
            return this._push(this.elements.flatMap(element =>
                element.children ? [...element.children] : []
            ).filter(element => !selector || element.matches(selector)));
        }

        closest(selector) {
            return this._push(this.elements.map(element =>
                typeof element.closest === 'function' ? element.closest(selector) : null
            ));
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

        add(selector, context) {
            return this._push([...this.elements, ...select(selector, context)]);
        }

        siblings(selector) {
            const matches = selector === undefined ? null : matcher(selector);
            return this._push(this.elements.flatMap(element =>
                element.parentElement ? [...element.parentElement.children]
                    .filter(sibling => sibling !== element) : []
            ).filter((element, index) => !matches || matches(element, index)));
        }

        next(selector) {
            const matches = selector === undefined ? null : matcher(selector);
            return this._push(this.elements.map(element => element.nextElementSibling)
                .filter(Boolean).filter((element, index) => !matches || matches(element, index)));
        }

        prev(selector) {
            const matches = selector === undefined ? null : matcher(selector);
            return this._push(this.elements.map(element => element.previousElementSibling)
                .filter(Boolean).filter((element, index) => !matches || matches(element, index)));
        }

        addClass(names) {
            const tokens = classes(names);
            return this.each((i, element) => {
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
            const tokens = classes(names);
            return this.each((i, element) => {
                if (!element.classList) return;
                tokens.forEach(token => {
                    if (force === undefined) element.classList.toggle(token);
                    else element.classList.toggle(token, Boolean(force));
                });
            });
        }

        hasClass(name) {
            return this.elements.some(element =>
                element.classList && element.classList.contains(name)
            );
        }

        text(value) {
            if (value === undefined) return this.get()?.textContent;
            return this.each((i, element) => { element.textContent = value == null ? '' : value; });
        }

        html(value) {
            if (value === undefined) return this.get()?.innerHTML;
            return this.each((i, element) => {
                if ('innerHTML' in element) element.innerHTML = value == null ? '' : value;
            });
        }

        val(value) {
            if (value === undefined) return this.get()?.value;
            return this.each((i, element) => {
                if ('value' in element) element.value = value == null ? '' : value;
            });
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
            return this.each((i, element) => element.removeAttribute?.(name));
        }

        css(property, value) {
            if (property && typeof property === 'object') {
                return this.each((i, element) => {
                    if (!element.style) return;
                    for (const [name, newValue] of Object.entries(property)) {
                        const key = cssName(name);
                        if (newValue == null) element.style.removeProperty(key);
                        else element.style.setProperty(key, String(newValue));
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
                if (value === null) element.style.removeProperty(key);
                else element.style.setProperty(key, String(value));
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

        // Direct: .on('click', handler[, options])
        // Delegated: .on('click', '.child', handler[, options])
        on(events, selector, handler, options) {
            return bindEvents(this, events, selector, handler, options, false);
        }

        // Like on(), but removes the listener after its first matching event.
        one(events, selector, handler, options) {
            return bindEvents(this, events, selector, handler, options, true);
        }

        // Removes MiniDOM listeners only; supports off(), off(types, handler),
        // off(types, selector, handler) and space-separated event names.
        off(events, selector, handler) {
            if (typeof selector === 'function') {
                handler = selector;
                selector = undefined;
            }
            const types = events == null ? null : splitEvents(events);
            return this.each((i, element) => {
                const records = [...(eventMemory.get(element) || [])];
                for (const record of records) {
                    if ((!types || types.includes(record.type)) &&
                        (selector === undefined || selector === record.selector) &&
                        (handler === undefined || handler === record.handler)) {
                        unbindRecord(element, record);
                    }
                }
            });
        }

        // Dispatch bubbling, cancelable DOM events (not native browser actions).
        // CustomEvent.detail is populated only when detail is supplied.
        trigger(events, detail) {
            return this.each((i, element) => {
                if (!element.dispatchEvent) return;
                for (const type of splitEvents(events)) {
                    const options = { bubbles: true, cancelable: true };
                    const event = detail === undefined
                        ? new global.Event(type, options)
                        : new global.CustomEvent(type, { ...options, detail });
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

        clone() {
            // Native cloneNode copies child nodes/attributes, not listeners.
            return this._push(this.elements.map(element => element.cloneNode(true)));
        }

        empty() {
            return this.each((i, element) => {
                if (element.replaceChildren) element.replaceChildren();
            });
        }

        remove() {
            return this.each((i, element) => element.remove?.());
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
