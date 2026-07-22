/*
 * Runtime du template historique de contestation.ch.
 *
 * Le balisage et les bindings restent compatibles avec le format initial
 * (`sc-if`, `sc-for`, `{{ valeur }}`, événements et refs), mais le rendu est
 * désormais différentiel : les éléments DOM existants sont mis à jour au lieu
 * d'être détruits à chaque frappe. Cela préserve naturellement le focus, le
 * curseur, le scroll, les accordéons, les clics en cours et le canvas.
 */
(function () {
  'use strict';

  function exprOf(binding) {
    if (binding == null) return '';
    var match = /\{\{\s*([\s\S]*?)\s*\}\}/.exec(binding);
    return match ? match[1].trim() : binding.trim();
  }

  function evalExpr(expr, scope, vals) {
    if (!expr) return undefined;
    var parts = expr.split('.');
    var head = parts[0];
    var base = scope && Object.prototype.hasOwnProperty.call(scope, head)
      ? scope[head]
      : vals && vals[head];
    for (var index = 1; index < parts.length && base != null; index += 1) {
      base = base[parts[index]];
    }
    return base;
  }

  function resolveFn(binding, scope, vals) {
    var fn = evalExpr(exprOf(binding), scope, vals);
    return typeof fn === 'function' ? fn : null;
  }

  function interp(value, scope, vals) {
    if (value.indexOf('{{') === -1) return value;
    return value.replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, function (_, expression) {
      var result = evalExpr(expression.trim(), scope, vals);
      return result == null ? '' : String(result);
    });
  }

  function DCLogic() {}

  DCLogic.prototype.setState = function (patch) {
    var previous = this.state;
    var next = typeof patch === 'function' ? patch(previous) : patch;
    if (!next || typeof next !== 'object') return;
    this.state = Object.assign({}, previous, next);
    if (typeof this.stateDidChange === 'function') {
      try { this.stateDidChange(previous, this.state); } catch (error) {
        console.error('stateDidChange_failed', error);
      }
    }
    DC.scheduleRender();
  };

  window.DCLogic = DCLogic;

  function bindEvent(element, type, fn) {
    var events = element.__dcEvents || (element.__dcEvents = {});
    var record = events[type];
    if (record) {
      record.fn = fn;
      return;
    }
    record = { fn: fn, listener: null };
    record.listener = function (event) {
      if (typeof record.fn === 'function') return record.fn.call(element, event);
    };
    events[type] = record;
    element.addEventListener(type, record.listener);
  }

  function syncEvents(current, desired) {
    var currentEvents = current.__dcEvents || (current.__dcEvents = {});
    var desiredEvents = desired.__dcEvents || {};

    Object.keys(currentEvents).forEach(function (type) {
      if (desiredEvents[type]) return;
      current.removeEventListener(type, currentEvents[type].listener);
      delete currentEvents[type];
    });

    Object.keys(desiredEvents).forEach(function (type) {
      bindEvent(current, type, desiredEvents[type].fn);
    });
  }

  function nodeKey(node) {
    if (!node || node.nodeType !== 1) return '';
    var explicit = node.getAttribute('data-dc-key');
    if (explicit) return 'key:' + explicit;
    var screen = node.getAttribute('data-screen-label');
    if (screen) return 'screen:' + screen;
    if (node.id) return 'id:' + node.id;
    if (/^(input|select|textarea)$/.test(node.localName) && node.dataset && node.dataset.k) {
      return 'field:' + node.dataset.k;
    }
    if (node.__dcRefName) return 'ref:' + node.__dcRefName;
    return '';
  }

  function nodesMatch(current, desired) {
    if (!current || !desired || current.nodeType !== desired.nodeType) return false;
    if (current.nodeType === 3) return true;
    if (current.nodeType !== 1 || current.localName !== desired.localName) return false;
    var currentKey = nodeKey(current);
    var desiredKey = nodeKey(desired);
    if (currentKey || desiredKey) return currentKey === desiredKey;
    return true;
  }

  function syncAttributes(current, desired) {
    var preserveDetailsState = current.localName === 'details';
    var currentNames = current.getAttributeNames();
    for (var index = 0; index < currentNames.length; index += 1) {
      var currentName = currentNames[index];
      if (preserveDetailsState && currentName === 'open') continue;
      if (!desired.hasAttribute(currentName)) current.removeAttribute(currentName);
    }

    var desiredNames = desired.getAttributeNames();
    for (var desiredIndex = 0; desiredIndex < desiredNames.length; desiredIndex += 1) {
      var desiredName = desiredNames[desiredIndex];
      if (preserveDetailsState && desiredName === 'open') continue;
      var value = desired.getAttribute(desiredName);
      if (current.getAttribute(desiredName) !== value) current.setAttribute(desiredName, value);
    }

    syncEvents(current, desired);
    current.__dcRefName = desired.__dcRefName || '';
    current.__dcRef = desired.__dcRef || null;
  }

  function syncControlValue(current, desired) {
    if (!Object.prototype.hasOwnProperty.call(desired, '__dcValue')) return;
    if (!('value' in current)) return;
    var value = desired.__dcValue == null ? '' : String(desired.__dcValue);
    if (current.__dcComposing) return;
    if (current.value !== value) current.value = value;
  }

  function keyAppearsLater(desiredNodes, start, key) {
    if (!key) return false;
    for (var index = start; index < desiredNodes.length; index += 1) {
      if (nodeKey(desiredNodes[index]) === key) return true;
    }
    return false;
  }

  function findChildByKey(parent, start, key) {
    if (!key) return null;
    for (var index = start; index < parent.childNodes.length; index += 1) {
      if (nodeKey(parent.childNodes[index]) === key) return parent.childNodes[index];
    }
    return null;
  }

  function patchNode(current, desired) {
    if (!nodesMatch(current, desired)) {
      current.replaceWith(desired);
      return desired;
    }

    if (current.nodeType === 3) {
      if (current.nodeValue !== desired.nodeValue) current.nodeValue = desired.nodeValue;
      return current;
    }

    syncAttributes(current, desired);
    patchChildren(current, desired);
    syncControlValue(current, desired);
    return current;
  }

  function patchChildren(currentParent, desiredParent) {
    var desiredNodes = Array.prototype.slice.call(desiredParent.childNodes);
    var targetIndex = 0;

    for (var desiredIndex = 0; desiredIndex < desiredNodes.length; desiredIndex += 1) {
      var desired = desiredNodes[desiredIndex];
      var current = currentParent.childNodes[targetIndex];
      var desiredKey = nodeKey(desired);
      var currentKey = nodeKey(current);

      if (desiredKey) {
        var keyedCurrent = findChildByKey(currentParent, targetIndex, desiredKey);
        if (keyedCurrent && keyedCurrent !== current) {
          currentParent.insertBefore(keyedCurrent, current || null);
          current = keyedCurrent;
          currentKey = desiredKey;
        } else if (!keyedCurrent && currentKey) {
          currentParent.insertBefore(desired, current);
          targetIndex += 1;
          continue;
        }
      } else if (currentKey && keyAppearsLater(desiredNodes, desiredIndex + 1, currentKey)) {
        currentParent.insertBefore(desired, current);
        targetIndex += 1;
        continue;
      }

      if (current) patchNode(current, desired);
      else currentParent.appendChild(desired);
      targetIndex += 1;
    }

    while (currentParent.childNodes.length > desiredNodes.length) {
      currentParent.removeChild(currentParent.lastChild);
    }
  }

  var DC = {
    component: null,
    template: null,
    mount: null,
    vals: null,
    _pending: false,
    _lastStep: null,
    _lastScreen: null,

    init: function (mount, templateContent, component) {
      this.mount = mount;
      this.template = Array.prototype.slice.call(templateContent.childNodes);
      this.component = component;
      this._lastStep = null;
      this._lastScreen = null;

      mount.addEventListener('compositionstart', function (event) {
        if (event.target) event.target.__dcComposing = true;
      }, true);
      mount.addEventListener('compositionend', function (event) {
        if (event.target) event.target.__dcComposing = false;
      }, true);

      this.render();
      if (typeof component.afterMount === 'function') {
        Promise.resolve().then(function () { return component.afterMount(); }).catch(function (error) {
          console.error('afterMount_failed', error);
        });
      }
    },

    scheduleRender: function () {
      if (this._pending) return;
      this._pending = true;
      var self = this;
      requestAnimationFrame(function () {
        self._pending = false;
        self.render();
      });
    },

    render: function () {
      try {
        this.vals = this.component.renderVals();
        var currentStep = this.component.state.step;
        var currentScreen = this.component.state.screen;
        var navigationChanged = this._lastStep !== currentStep || this._lastScreen !== currentScreen;
        this._suppressEnterAnim = !navigationChanged;

        var fragment = document.createDocumentFragment();
        for (var index = 0; index < this.template.length; index += 1) {
          var built = this.build(this.template[index], {});
          if (built) fragment.appendChild(built);
        }

        patchChildren(this.mount, fragment);
        this.runRefs();
        if (navigationChanged) {
          var activeScroller = this.mount.querySelector('.cc-scroll');
          if (activeScroller) activeScroller.scrollTop = 0;
        }
        this._lastStep = currentStep;
        this._lastScreen = currentScreen;
        if (typeof this.component.afterRender === 'function') this.component.afterRender();
      } catch (error) {
        // Le DOM précédent reste visible et utilisable si un binding inattendu
        // échoue : un rendu défectueux ne doit jamais vider toute la page.
        console.error('dc_render_failed', error);
      }
    },

    build: function (node, scope) {
      if (node.nodeType === 3) return document.createTextNode(interp(node.nodeValue, scope, this.vals));
      if (node.nodeType !== 1) return null;

      var tag = node.localName;
      if (tag === 'sc-if') {
        var condition = evalExpr(exprOf(node.getAttribute('value')), scope, this.vals);
        var conditional = document.createDocumentFragment();
        if (condition) this.appendChildren(conditional, node, scope);
        return conditional;
      }

      if (tag === 'sc-for') {
        var list = evalExpr(exprOf(node.getAttribute('list')), scope, this.vals) || [];
        var name = node.getAttribute('as') || 'item';
        var repeated = document.createDocumentFragment();
        for (var index = 0; index < list.length; index += 1) {
          var childScope = Object.assign({}, scope);
          childScope[name] = list[index];
          childScope.$index = index;
          this.appendChildren(repeated, node, childScope);
        }
        return repeated;
      }

      var element = document.createElement(tag);
      this.applyAttrs(element, node, scope);
      this.appendChildren(element, node, scope);
      syncControlValue(element, element);

      var refAttr = node.getAttribute('ref');
      if (refAttr) {
        element.__dcRefName = exprOf(refAttr);
        element.__dcRef = evalExpr(element.__dcRefName, scope, this.vals);
      }
      return element;
    },

    appendChildren: function (target, node, scope) {
      for (var index = 0; index < node.childNodes.length; index += 1) {
        var built = this.build(node.childNodes[index], scope);
        if (built) target.appendChild(built);
      }
    },

    applyAttrs: function (element, node, scope) {
      for (var index = 0; index < node.attributes.length; index += 1) {
        var name = node.attributes[index].name;
        var raw = node.attributes[index].value;
        if (name === 'hint-placeholder-val' || name === 'hint-placeholder-count' || name === 'ref') continue;

        if (name === 'onclick' || name === 'oninput' || name === 'onchange') {
          var fn = resolveFn(raw, scope, this.vals);
          if (!fn) continue;
          var type = name.slice(2);
          bindEvent(element, type, fn);
          // Les anciens templates utilisaient `onChange` pour les champs. On
          // synchronise aussi à chaque saisie afin qu'une fermeture ou un clic
          // immédiat ne puisse jamais perdre le dernier caractère.
          if (type === 'change') bindEvent(element, 'input', fn);
          continue;
        }

        if (name === 'value') {
          var value = interp(raw, scope, this.vals);
          element.__dcValue = value;
          element.dataset.k = exprOf(raw);
          continue;
        }

        if (name === 'style') {
          var style = interp(raw, scope, this.vals);
          if (this._suppressEnterAnim && style.indexOf('fadeUp') !== -1) {
            style = style.replace(/animation\s*:[^;]*fadeUp[^;]*;?/g, '');
          }
          element.setAttribute('style', style);
          continue;
        }

        element.setAttribute(name, interp(raw, scope, this.vals));
      }
    },

    runRefs: function () {
      var elements = this.mount.querySelectorAll('*');
      for (var index = 0; index < elements.length; index += 1) {
        var element = elements[index];
        if (!element.__dcRefName || typeof element.__dcRef !== 'function') continue;
        if (element.__dcRefBound === element.__dcRefName) continue;
        element.__dcRefBound = element.__dcRefName;
        element.__dcRef(element);
      }
    },

    flush: function () {
      if (!this._pending) return;
      this._pending = false;
      this.render();
    },
  };

  window.__DC = DC;
  window.__bootDC = function (ComponentClass) {
    var mount = document.getElementById('app');
    var template = document.getElementById('dc-template');
    if (!mount || !template) throw new Error('Point de montage du front introuvable');
    DC.init(mount, template.content, new ComponentClass());
  };
})();
