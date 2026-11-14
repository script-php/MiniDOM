/* MiniDOM v0.0.2 — small, chainable DOM helper. No dependencies. */
(function (global) {
    'use strict';

    const VERSION = '0.0.2';
    const previousDollar = global.$;
    const displayMemory = new WeakMap();
    const eventMemory = new WeakMap();

    function isNode(value) {
        return value != null && typeof value.nodeType === 'number';
    }

    function unique(items) {
        return [...new Set(items.filter(Boolean))];
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
        if (typeof value !== 'string') return unique(nodes(value));

        // A context can itself be a CSS selector, node, or MiniDOM collection.
        const roots = context === undefined
            ? [global.document]
            : typeof context === 'string'
                ? [...global.document.querySelectorAll(context)]
                : nodes(context);

        return unique(roots.flatMap(root =>
            root && typeof root.querySelectorAll === 'function'
                ? [...root.querySelectorAll(value)]
                : []
        ));
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
        const targets = destinations.filter(target =>
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

    function matching(element, selector, index) {
        if (typeof selector === 'function') {
            return Boolean(selector.call(element, index, element));
        }
        if (typeof selector === 'string') {
            return typeof element.matches === 'function' && element.matches(selector);
        }
        return nodes(selector).includes(element);
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
            return this._push(unique(this.elements.flatMap(element =>
                typeof element.querySelectorAll === 'function'
                    ? [...element.querySelectorAll(selector)] : []
            )));
        }

        parent(selector) {
            return this._push(unique(this.elements.map(element => element.parentElement)
                .filter(element => !selector || element.matches(selector))));
        }

        children(selector) {
            return this._push(unique(this.elements.flatMap(element =>
                element.children ? [...element.children] : []
            ).filter(element => !selector || element.matches(selector))));
        }

        closest(selector) {
            return this._push(unique(this.elements.map(element =>
                typeof element.closest === 'function' ? element.closest(selector) : null
            )));
        }

        filter(selector) {
            return this._push(this.elements.filter((element, index) =>
                matching(element, selector, index)
            ));
        }

        not(selector) {
            return this._push(this.elements.filter((element, index) =>
                !matching(element, selector, index)
            ));
        }

        is(selector) {
            return this.elements.some((element, index) => matching(element, selector, index));
        }

        add(selector, context) {
            return this._push(unique([...this.elements, ...select(selector, context)]));
        }

        siblings(selector) {
            return this._push(unique(this.elements.flatMap(element =>
                element.parentElement ? [...element.parentElement.children]
                    .filter(sibling => sibling !== element) : []
            ).filter((element, index) => selector === undefined || matching(element, selector, index))));
        }

        next(selector) {
            return this._push(unique(this.elements.map(element => element.nextElementSibling)
                .filter(Boolean).filter((element, index) =>
                    selector === undefined || matching(element, selector, index)
                )));
        }

        prev(selector) {
            return this._push(unique(this.elements.map(element => element.previousElementSibling)
                .filter(Boolean).filter((element, index) =>
                    selector === undefined || matching(element, selector, index)
                )));
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

        // Direct:   $(...).on('click', handler)
        // Delegated: $(...).on('click', '.child', handler)
        on(events, selector, handler, options) {
            if (typeof selector === 'function') {
                options = handler;
                handler = selector;
                selector = null;
            }
            if (typeof handler !== 'function') throw new TypeError('on() requires a handler');

            return this.each((i, element) => {
                if (!element.addEventListener) return;
                const records = eventMemory.get(element) || [];
                for (const type of splitEvents(events)) {
                    const wrapped = selector ? function (event) {
                        const target = event.target?.nodeType === 1
                            ? event.target : event.target?.parentElement;
                        const matched = target?.closest(selector);
                        if (matched && (matched === element || element.contains?.(matched))) {
                            handler.call(matched, event);
                        }
                    } : handler;
                    element.addEventListener(type, wrapped, options);
                    records.push({ type, selector, handler, wrapped, options });
                }
                eventMemory.set(element, records);
            });
        }

        // Removes only handlers registered by MiniDOM.
        // off() / off('click') / off('click', handler) / off('click', '.child', handler)
        off(events, selector, handler) {
            if (typeof selector === 'function') {
                handler = selector;
                selector = undefined;
            }
            const types = events == null ? null : splitEvents(events);
            return this.each((i, element) => {
                const records = eventMemory.get(element) || [];
                const remaining = [];
                for (const record of records) {
                    const match = (!types || types.includes(record.type)) &&
                        (selector === undefined || selector === record.selector) &&
                        (handler === undefined || handler === record.handler);
                    if (match) element.removeEventListener(record.type, record.wrapped, record.options);
                    else remaining.push(record);
                }
                if (remaining.length) eventMemory.set(element, remaining);
                else eventMemory.delete(element);
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
