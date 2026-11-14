<div align="center">

# MiniDOM

**A small, dependency-free JavaScript library for working with the DOM.**

*Select. Traverse. Manipulate. Listen. Chain.*

[Getting started](#getting-started) · [Examples](#practical-examples) · [API reference](#complete-api-reference) · [Security](#security) · [Testing](#testing)

</div>

---

MiniDOM wraps native browser DOM APIs in a lightweight, familiar `$()` interface. Use it to select elements, traverse a page, manipulate content, handle events, work with forms, observe changes, and build interactive interfaces without a framework or runtime dependencies.

```js
$('.task')
  .addClass('ready')
  .on('click', function () {
    $(this).toggleClass('completed');
  });
```

> [!NOTE]
> MiniDOM takes inspiration from the ergonomics of jQuery, but **is not a drop-in replacement**. See the API reference and [important behavior](#important-behavior-and-limitations) before migrating an existing application.

## Highlights

- **One familiar entry point** — select with `$()` or `MiniDOM()`.
- **Chainable collections** — compose selectors, traversal, DOM updates, and event bindings.
- **No runtime dependencies** — just include the JavaScript file in a browser page.
- **DOM manipulation** — insert, replace, wrap, clone, remove, or detach nodes.
- **Events** — direct, delegated, one-time, and namespaced listeners, with cleanup support.
- **Forms and data** — read/write form fields, serialize forms, and store per-element data.
- **Layout and effects** — styles, dimensions, scrolling, visibility, and fades.
- **Observers** — convenient MutationObserver and ResizeObserver subscriptions.
- **Cleanup-aware operations** — managed listeners, observers, data, and animations are cleaned up by destructive removal methods.

## Getting started

Download `minidom.js`, put it in your project, and load it **before** scripts that use MiniDOM:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MiniDOM example</title>
</head>
<body>
  <button id="counter">Clicked 0 times</button>

  <script src="minidom.js"></script>
  <script>
    $(() => {
      let clicks = 0;

      $('#counter').on('click', function () {
        clicks++;
        $(this).text(`Clicked ${clicks} times`);
      });
    });
  </script>
</body>
</html>
```

MiniDOM exposes two browser globals: **`$`** and **`MiniDOM`**. Both refer to the same function when the library first loads. To release the `$` alias for another library:

```js
const md = MiniDOM.noConflict();
md('.item').addClass('active');
```

### Selecting elements

```js
$('.card');                           // CSS selector
$('#profile');                        // ID selector
$('li', document.querySelector('ul')); // Selector within a context
$(document.querySelector('.card'));   // Existing DOM node
$([nodeA, nodeB]);                    // Collection of nodes
$(() => console.log('DOM ready'));    // DOM-ready callback
```

Most methods that change elements return a MiniDOM collection, so you can chain operations:

```js
$('.notice')
  .text('Saved successfully')
  .addClass('success')
  .show();
```

Getter methods usually read the **first** selected element, while setters update the selected elements. Methods that traverse or filter return a new collection; `.end()` returns to the previous collection in the chain.

## Practical examples

### 1. Traversal and filtering

```js
$('.menu')
  .find('a')
  .filter('.enabled')
  .addClass('interactive')
  .end()                     // Back to all links found by .find()
  .attr('aria-label', 'Menu link');

const selected = $('.card').filter('.selected');
const firstTitle = $('.card').first().find('.title').text();
```

### 2. Dynamic UI and delegated events

Delegation lets a parent respond to descendants created **after** the handler was registered.

```html
<ul id="tasks"></ul>
<button id="add-task">Add task</button>
```

```js
let nextId = 1;

$('#add-task').on('click', () => {
  const item = document.createElement('li');
  item.className = 'task';
  item.dataset.id = String(nextId++);
  item.textContent = 'New task'; // Safe for text, including user input
  $('#tasks').append(item);
});

$('#tasks').on('click.tasks', '.task', function () {
  $(this).toggleClass('done');
});

// Later, remove listeners in this namespace:
// $('#tasks').off('.tasks');
```

### 3. Form fields and submission

```html
<form id="contact-form">
  <input name="name" required>
  <input name="email" type="email" required>
  <button type="submit">Send</button>
</form>
<p id="message"></p>
```

```js
$('#contact-form').on('submit', function (event) {
  event.preventDefault();

  const fields = $(this).serializeArray();
  const params = $(this).serialize();
  const payload = $(this).formData(); // Native FormData; supports files

  $('#message').text(`Prepared ${fields.length} fields`);
  console.log(params, payload);
});
```

### 4. Events and one-time handlers

```js
$('#save').one('click', function () {
  console.log('Runs only once');
});

$('.panel').on('custom:event', function (event) {
  console.log(event.detail);
});

$('.panel').trigger('custom:event', { source: 'demo' });

const controller = new AbortController();
$('#cancel').on('click', () => console.log('clicked'), {
  signal: controller.signal
});
controller.abort();
```

`trigger()` dispatches **unnamespaced native events**. For namespaced, MiniDOM-managed handlers, use `.triggerHandler()` where appropriate; it runs on the first selected node without bubbling.

### 5. Element data

```js
const card = $('.card').first();

card.data('recordId', 42);
console.log(card.data('recordId')); // 42
console.log(card.data());           // Data attributes + managed cache

card.removeData('recordId');
```

Managed `.data()` values are separate from HTML `data-*` attributes. Setting a value with `.data()` does **not** update the attribute in the DOM.

### 6. Clone, detach, and remove

```js
const original = $('.template-card').first();

const copy = original.clone(true); // Copy DOM plus MiniDOM-managed data/events
$('#list').append(copy);

const saved = copy.detach();        // Temporarily take the node out
$('#archive').append(saved);        // Reattach the same node

saved.remove();                     // Remove with managed cleanup
```

`.clone()` clones DOM nodes only; `.clone(true)` also copies MiniDOM-managed events and data on the root and descendants. `.clone(true, false)` copies managed state on the root only. Native listeners registered outside MiniDOM are not cloned.

### 7. Observing changes

```js
const list = $('#tasks');

function onMutations({ added, removed, records, root }) {
  console.log('DOM changed', { added, removed, records, root });
}

list.observeMutations(onMutations, { childList: true, subtree: true });

const panel = $('.panel');
function onResize(width, height, entry) {
  console.log({ width, height, entry });
}

panel.observeResize(onResize);

// When observation is no longer needed:
list.unobserveMutations(onMutations);
panel.unobserveResize(onResize);
```

## Complete API reference

The tables below cover the **entire public Collection API**, grouped by purpose. Signatures show the most useful supported arguments; `?` means optional, and `...` denotes multiple items. Methods generally return a chainable Collection unless described as getters or returning another value.

### Global entry points

| API | Description |
|---|---|
| `$(selector?, context?)` | Create a collection from a selector, node, or collection-like input; a function registers a DOM-ready callback. |
| `MiniDOM(selector?, context?)` | Full-name equivalent of `$()`. |
| `MiniDOM.fn` | Collection prototype, for inspection or intentional extensions. |
| `MiniDOM.noConflict()` | Restore the prior `$` global (if MiniDOM still owns it) and return `MiniDOM`. |

### Collection basics and selection

| API | Description |
|---|---|
| `.length` | Number of items in the collection (read-only getter). |
| `.get(index?)` | Return a native item; defaults to the first. Negative indexes are supported. |
| `.toArray()` | Return a shallow copy of collection items as an array. |
| `.each(callback)` | Iterate with `(index, element)`, binding `this` to the current element. |
| `.map(callback)` | Map and flatten returned values into a new collection. |
| `.first()` / `.last()` | Select the first or last item. |
| `.eq(index)` | Select the item at an index; negatives count from the end. |
| `.slice(start, end?)` | Select a range of items. |
| `.even()` / `.odd()` | Select zero-based even or odd collection positions. |
| `.index(value?)` | Get first element's sibling index, or locate a matching item/selector. |
| `.add(selector, context?)` | Add matching items to a new collection. |
| `.addBack(selector?)` | Add the preceding collection (optionally filtered). |
| `.end()` | Return to the preceding collection in a chain. |
| `.filter(selector)` | Keep matching elements; supports a selector, element set, or callback. |
| `.not(selector)` | Exclude matching elements. |
| `.is(selector)` | Return whether any item matches. |
| `.has(selector)` | Keep items containing a matching descendant. |
| `.contains(target)` | Return whether the first item contains the target. |

### DOM traversal

| API | Description |
|---|---|
| `.find(selector)` | Find descendants matching a selector or supplied nodes. |
| `.parent(selector?)` | Immediate parent elements. |
| `.parents(selector?)` | All parent elements. |
| `.parentsUntil(until, selector?)` | Ancestors before a stopping match. |
| `.children(selector?)` | Direct element children. |
| `.contents()` | Child nodes, template content nodes, or an accessible iframe document. |
| `.closest(selector, context?)` | Nearest matching ancestor, including the starting element. |
| `.siblings(selector?)` | Sibling elements excluding each selected item. |
| `.next(selector?)` / `.prev(selector?)` | Immediately adjacent element siblings. |
| `.nextAll(selector?)` / `.prevAll(selector?)` | All following or preceding element siblings. |
| `.nextUntil(until, selector?)` | Following siblings before a stopping match. |
| `.prevUntil(until, selector?)` | Preceding siblings before a stopping match. |

### Content, insertion, and removal

| API | Description |
|---|---|
| `.text(value?)` | Read text from the first item, or set text on selected nodes; safe for plain user text. |
| `.html(value?)` | Read or replace HTML content. **Does not sanitize markup.** |
| `.append(...content)` | Insert content as the last children of the selected destinations. |
| `.prepend(...content)` | Insert content as the first children. |
| `.before(...content)` / `.after(...content)` | Insert content adjacent to selected nodes. |
| `.appendTo(target)` / `.prependTo(target)` | Insert the current selection into a destination. |
| `.insertBefore(target)` / `.insertAfter(target)` | Insert the selection adjacent to target nodes. |
| `.replaceWith(...content)` | Replace selected targets with content. |
| `.replaceAll(target)` | Replace targets using the current selection. |
| `.empty()` | Remove child nodes and clean up their MiniDOM-managed state. |
| `.remove()` | Remove selected nodes and clean up managed descendants. |
| `.detach()` | Detach nodes while retaining managed state for later reinsertion. |
| `.clone(withDataAndEvents?, deepWithDataAndEvents?)` | Clone DOM nodes, optionally copying MiniDOM-managed events and data. |
| `.wrap(content)` | Wrap each selected element. |
| `.wrapAll(content)` | Wrap the entire selection in one wrapper. |
| `.wrapInner(content)` | Wrap each selected element's inner contents. |
| `.unwrap()` | Remove a parent wrapper while preserving its children, subject to document-root safeguards. |

For supported insertion and wrapping operations, callback-based content can be used to compute content from a destination. **Only provide trusted markup** when returning HTML strings.

### Attributes, properties, and classes

| API | Description |
|---|---|
| `.attr(name, value?)` | Read or set HTML attributes; object maps are supported. |
| `.removeAttr(names)` | Remove one or more space-separated attributes. |
| `.prop(name, value?)` | Read or set native JavaScript properties; object maps are supported. |
| `.removeProp(name)` | Remove an own property where supported. |
| `.addClass(names)` | Add one or more classes. |
| `.removeClass(names)` | Remove classes. |
| `.toggleClass(names, force?)` | Toggle classes or force their presence/absence. |
| `.hasClass(name)` | Check whether any selected element has a class. |

```js
$('.button')
  .attr('aria-expanded', 'true')
  .prop('disabled', false)
  .addClass('active');
```

### CSS, visibility, dimensions, and positioning

| API | Description |
|---|---|
| `.css(property, value?)` | Get computed CSS or set styles; supports maps and CSS declaration strings. |
| `.show()` / `.hide()` | Show or hide selected elements. |
| `.toggle(force?)` | Toggle visibility; optional boolean forces show or hide. |
| `.isVisible()` | Check whether the first element occupies rendered layout boxes. |
| `.width(value?)` / `.height(value?)` | Get or set dimensions. |
| `.innerWidth(value?)` / `.innerHeight(value?)` | Get or set inner box dimensions. |
| `.outerWidth(value?, includeMargin?)` | Read/set outer width using supported box behavior. |
| `.outerHeight(value?, includeMargin?)` | Read/set outer height using supported box behavior. |
| `.offset(value?)` | Get document-relative `{ top, left }` or set target coordinates. |
| `.position()` | Get `{ top, left }` relative to the offset parent. |
| `.offsetParent()` | Return the first element's offset parent as a collection. |
| `.scrollTop(value?)` / `.scrollLeft(value?)` | Read or set scroll positions. |
| `.scrollIntoView(options?)` | Scroll selected elements into view with native browser options. |
| `.fadeIn(duration?)` / `.fadeOut(duration?)` | Animate visibility using the Web Animations API when available. |

`isVisible()` does not indicate whether an element is inside the viewport or unobscured by other elements. CSS reads are computed-style reads and may force layout.

### Events and lifecycle

| API | Description |
|---|---|
| `.on(events, handler, options?)` | Register direct event handlers. |
| `.on(events, selector, handler, options?)` | Register delegated event handlers for matching descendants. |
| `.one(events, handler, options?)` | Register a one-time handler; also supports delegation. |
| `.off(events?, selector?, handler?)` | Remove MiniDOM-managed listeners, including namespaced registrations. |
| `.trigger(events, detail?)` | Dispatch bubbling native events; **event names must be unnamespaced**. |
| `.triggerHandler(eventName, detail?)` | Run matching direct managed handlers on the first node without bubbling; return the last handler result. |
| `.hover(enter, leave?)` | Bind mouseenter and mouseleave handlers. |
| `.ready(callback)` | Register a callback for DOM readiness; returns the collection. |
| `.focus(options?)` / `.blur()` | Focus or blur selected elements. |

**Event namespaces:** register with `.on('click.dashboard', handler)` and remove with `.off('.dashboard')`. The `.trigger()` method intentionally does not dispatch namespaced event strings. Handlers may use supported native listener options, including `AbortSignal`.

### Forms and values

| API | Description |
|---|---|
| `.val(value?)` | Get/set a form control's value. |
| `.formData(submitter?)` | Return native `FormData` from the first selected form; includes file entries. |
| `.serializeArray()` | Return successful text form fields as `{ name, value }` records; omits file entries. |
| `.serialize()` | Encode successful text fields as a URL-encoded string. |
| `.serializeJSON()` | Convert serialized fields into a JavaScript object. |
| `.reset()` | Reset selected forms. |

`.serializeArray()`, `.serialize()` and `.serializeJSON()` are for form values; for actual file uploads, use `.formData()`.

### Managed data and observation

| API | Description |
|---|---|
| `.data(key?, value?)` | Read data attributes/cache or set managed data; supports object maps. |
| `.removeData(key?)` | Remove one or more cached data keys, or all cached data. |
| `.observeMutations(callback, options?)` | Subscribe to native mutation records on selected nodes; callbacks receive `{ added, removed, records, root }`. |
| `.unobserveMutations(callback?)` | Remove one or all managed mutation subscriptions. |
| `.observeResize(callback)` | Subscribe to resize changes; callback receives `(width, height, nativeEntry)`. |
| `.unobserveResize(callback?)` | Remove one or all managed resize subscriptions. |

Mutation and resize observation rely on the corresponding browser observer APIs. Use the `unobserve*` methods for explicit teardown, especially for long-lived UI components.

## Important behavior and limitations

MiniDOM aims for a convenient DOM experience, not full jQuery emulation.

- **Browser-first:** It expects a browser `window`/`document`, not a Node.js server-side DOM environment.
- **Extended selector support is limited:** Standard CSS selectors use browser capabilities; supported MiniDOM-specific positional/visibility selectors are not a promise to support all jQuery selector extensions.
- **Collection indexing:** `.get(0)` and `[0]` return native DOM nodes. `.eq(0)` returns a MiniDOM collection.
- **Unique selection behavior:** Collection creation can deduplicate nodes and omit nullish values. Do not rely on duplicate positions surviving a selection.
- **Getter and setter distinction:** Getter calls usually operate on the first item; setters commonly iterate the collection.
- **Event compatibility:** `.trigger()` uses native dispatch and rejects namespaced event names; `.triggerHandler()` only calls direct MiniDOM-managed callbacks on the first node.
- **Managed state:** `.clone(true)` can clone MiniDOM-managed listeners/data, but cannot clone listeners attached through native `addEventListener()`.
- **Shadow DOM:** Accessible open roots are supported in defined cleanup/cloning paths; closed shadow roots are not introspectable.
- **Animations:** Fades use browser Web Animations support when available and fall back to immediate visibility changes when needed.
- **Security:** HTML-parsing APIs do not sanitize input, and URL/style setters do not validate values.

## Security

> [!WARNING]
> **MiniDOM is not an HTML sanitizer.** Never treat string-based HTML insertion as a safe way to display untrusted content.

Prefer `.text()` (or native `textContent`) for anything originating from users, APIs, or other untrusted sources:

```js
const userComment = '<img src=x onerror=alert(1)>';

// Safe: shows the literal text, not parsed HTML.
$('#comment').text(userComment);

// Unsafe: do NOT pass untrusted content to HTML insertion methods.
// $('#comment').html(userComment);
```

If your application needs rich user-supplied HTML, sanitize it **before** passing it to MiniDOM, using an independently maintained sanitizer and an appropriate application security policy. Consider restrictive CSP and Trusted Types enforcement in supported browsers; neither replaces sanitization. Validate URL-bearing attributes such as `href` and `src`, and avoid unsafe inline event-handler attributes or CSS values.


## Design principles

1. **Stay small and useful.** Offer the DOM operations people reach for most often.
2. **Build on browser standards.** Prefer native platform APIs over unnecessary abstraction.
3. **Keep behavior predictable.** A readable and chainable interface should still make sense to JavaScript developers.
4. **Handle resource lifecycles.** Event and observer cleanup matter in dynamic applications.
5. **Keep trust boundaries explicit.** Convenience methods must not be confused with sanitization or security policy enforcement.

---

<div align="center">

**MiniDOM** — a little less boilerplate, a lot more DOM.

</div>
