/* MiniDOM v0.0.1 — small, chainable DOM helper. No dependencies. */
(function (global) {
    'use strict';

    const VERSION = '0.0.1';
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

    class Collection {
        constructor(elements, previous = null) {
            this.elements = unique(elements);
            this.previous = previous;
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
            return this._push(this.elements.filter(element =>
                typeof element.matches === 'function' && element.matches(selector)
            ));
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
