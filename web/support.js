/*
 * support.js — minimal runtime for the "design component" (.dc) template format
 * used by web/index.html. It renders the design markup embedded in
 * <template id="dc-template"> against a Component instance's renderVals().
 *
 * Supported template syntax (a faithful subset of the Claude Design DC format):
 *   <sc-if value="{{ expr }}">…</sc-if>      conditional block
 *   <sc-for list="{{ arr }}" as="x">…</sc-for>  repeat block, x scoped inside
 *   {{ expr }}                                interpolation in text and attributes
 *   onClick / onInput / onChange="{{ fn }}"   event bindings (fn from renderVals)
 *   ref="{{ fn }}"                            imperative node ref (called once)
 *   value="{{ expr }}"                        controlled input value
 *
 * `expr` is a dotted path resolved first against the current loop scope, then
 * against the object returned by Component.renderVals().
 */
(function () {
  'use strict';

  // ── expression helpers ───────────────────────────────────────────────
  function exprOf(binding) {
    if (binding == null) return '';
    var m = /\{\{\s*([\s\S]*?)\s*\}\}/.exec(binding);
    return m ? m[1].trim() : binding.trim();
  }
  function evalExpr(expr, scope, vals) {
    if (!expr) return undefined;
    var parts = expr.split('.');
    var head = parts[0];
    var base = (scope && Object.prototype.hasOwnProperty.call(scope, head))
      ? scope[head]
      : (vals ? vals[head] : undefined);
    for (var i = 1; i < parts.length && base != null; i++) base = base[parts[i]];
    return base;
  }
  function resolveFn(binding, scope, vals) {
    var fn = evalExpr(exprOf(binding), scope, vals);
    return (typeof fn === 'function') ? fn : null;
  }
  function interp(str, scope, vals) {
    if (str.indexOf('{{') === -1) return str;
    return str.replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, function (_, e) {
      var v = evalExpr(e.trim(), scope, vals);
      return (v == null) ? '' : String(v);
    });
  }
  function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  // ── base class exposed to the component ──────────────────────────────
  function DCLogic() {}
  DCLogic.prototype.setState = function (patch) {
    var next = (typeof patch === 'function') ? patch(this.state) : patch;
    this.state = Object.assign({}, this.state, next);
    DC.scheduleRender();
  };
  window.DCLogic = DCLogic;

  // ── renderer ─────────────────────────────────────────────────────────
  var DC = {
    component: null,
    template: null,   // array of template top-level nodes
    mount: null,
    vals: null,
    refCache: {},     // refName -> persisted live element (canvas, etc.)
    _pending: false,

    init: function (mount, templateContent, component) {
      this.mount = mount;
      this.template = Array.prototype.slice.call(templateContent.childNodes);
      this.component = component;
      this.render();
    },

    scheduleRender: function () {
      if (this._pending) return;
      this._pending = true;
      var self = this;
      requestAnimationFrame(function () { self._pending = false; self.render(); });
    },

    render: function () {
      this.vals = this.component.renderVals();

      // Preserve focus + caret across the full rebuild.
      var act = document.activeElement, focusKey = null, selS = null, selE = null;
      if (act && act.dataset && act.dataset.k) {
        focusKey = act.dataset.k;
        try { selS = act.selectionStart; selE = act.selectionEnd; } catch (e) {}
      }

      var frag = document.createDocumentFragment();
      for (var i = 0; i < this.template.length; i++) {
        var built = this.build(this.template[i], {});
        if (built) frag.appendChild(built);
      }
      this.mount.replaceChildren(frag);

      if (focusKey) {
        var el = this.mount.querySelector('[data-k="' + cssEscape(focusKey) + '"]');
        if (el) {
          el.focus();
          if (selS != null) { try { el.setSelectionRange(selS, selE); } catch (e2) {} }
        }
      }
    },

    build: function (node, scope) {
      if (node.nodeType === 3) return document.createTextNode(interp(node.nodeValue, scope, this.vals));
      if (node.nodeType !== 1) return null; // comments etc.

      var tag = node.localName;

      if (tag === 'sc-if') {
        var cond = evalExpr(exprOf(node.getAttribute('value')), scope, this.vals);
        var f = document.createDocumentFragment();
        if (cond) this.appendChildren(f, node, scope);
        return f;
      }

      if (tag === 'sc-for') {
        var list = evalExpr(exprOf(node.getAttribute('list')), scope, this.vals) || [];
        var as = node.getAttribute('as') || 'item';
        var ff = document.createDocumentFragment();
        for (var k = 0; k < list.length; k++) {
          var cs = Object.assign({}, scope);
          cs[as] = list[k];
          cs.$index = k;
          this.appendChildren(ff, node, cs);
        }
        return ff;
      }

      // ref'd elements persist across renders (keeps canvas drawing + listeners)
      var refAttr = node.getAttribute('ref');
      if (refAttr) {
        var refName = exprOf(refAttr);
        var cached = this.refCache[refName];
        if (!cached) {
          cached = document.createElement(tag);
          this.applyAttrs(cached, node, scope);
          this.appendChildren(cached, node, scope);
          this.refCache[refName] = cached;
          var fn = evalExpr(refName, scope, this.vals);
          if (typeof fn === 'function') fn(cached);
        }
        return cached;
      }

      var el = document.createElement(tag);
      this.applyAttrs(el, node, scope);
      this.appendChildren(el, node, scope);
      return el;
    },

    appendChildren: function (target, node, scope) {
      var kids = node.childNodes;
      for (var i = 0; i < kids.length; i++) {
        var b = this.build(kids[i], scope);
        if (b) target.appendChild(b);
      }
    },

    applyAttrs: function (el, node, scope) {
      var attrs = node.attributes;
      for (var i = 0; i < attrs.length; i++) {
        var name = attrs[i].name; // parser lowercases HTML attribute names
        var raw = attrs[i].value;

        if (name === 'hint-placeholder-val' || name === 'hint-placeholder-count' || name === 'ref') continue;

        if (name === 'onclick' || name === 'oninput' || name === 'onchange') {
          var fn = resolveFn(raw, scope, this.vals);
          if (fn) el.addEventListener(name.slice(2), fn);
          continue;
        }

        if (name === 'value') {
          var v = interp(raw, scope, this.vals);
          el.value = v;
          el.setAttribute('value', v);
          el.dataset.k = exprOf(raw);
          continue;
        }

        el.setAttribute(name, interp(raw, scope, this.vals));
      }
    }
  };

  window.__DC = DC;
  window.__bootDC = function (ComponentClass) {
    var mount = document.getElementById('app');
    var tpl = document.getElementById('dc-template');
    DC.init(mount, tpl.content, new ComponentClass());
  };
})();
