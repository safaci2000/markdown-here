/*
 * Copyright Adam Pritchard 2013
 * MIT License : http://adampritchard.mit-license.org/
 */


;(function() {

"use strict";
/*global module:false, chrome:false, Components:false*/

/*
 * Chrome storage helper. Gets around the synchronized value size limit.
 * Overall quota limits still apply (or less, but we should stay well within).
 * Limitations:
 *   - `get` gets the entire options object and `set` sets the entire options
 *     object (unlike the underlying `chrome.storage.sync` functions).
 *
 * Long strings are broken into pieces and stored in separate fields. They are
 * recombined when retrieved.
 *
 * Note that we fall back to (unsynced) localStorage if chrome.storage isn't
 * available. This is the case in Chromium v18 (currently the latest available
 * via Ubuntu repo). Part of the reason we JSON-encode values is to get around
 * the fact that you can only store strings with localStorage.
 *
 * Chrome note/warning: OptionsStore can't be used directly from a content script.
 * When it tries to fill in the CSS defaults with a XHR request, it'll fail with
 * a cross-domain restriction error. Instead use the service provided by the
 * background script.
 */

// TODO: Check for errors. See: https://code.google.com/chrome/extensions/dev/storage.html

var ChromeOptionsStore = {

  // The options object will be passed to `callback`
  get: function(callback) {
    var that = this;

    this._storageGet(function(sync) {

      // Process the object, recombining divided entries.
      var tempobj = {}, finalobj = {};
      for (var key in sync) {
        var val = sync[key];
        var divIndex = key.indexOf(that._div);

        if (divIndex < 0) {
          finalobj[key] = val;
        }
        else {
          var keybase = key.slice(0, divIndex);
          var keynum = key.slice(divIndex+that._div.length);
          tempobj[keybase] = tempobj[keybase] || [];
          tempobj[keybase][keynum] = val;
        }
      }

      // Recombine the divided entries.
      for (key in tempobj) {
        finalobj[key] = tempobj[key].join('');
      }

      that._fillDefaults(finalobj, callback);
    });
  },

  // Store `obj`, splitting long strings when necessary. `callback` will be
  // called (with no arguments) when complete.
  set: function(obj, callback) {
    var that = this;

    // First clear out existing entries.
    this._clearExisting(obj, function() {

      // Split long string entries into pieces, so we don't exceed the limit.
      var finalobj = {};
      for (var key in obj) {
        var val = obj[key];
        if (typeof(val) !== 'string' || val.length < that._maxlen()) {
          // Don't need to split, or can't.
          finalobj[key] = val;
        }
        else {
          var pieces = Math.ceil(val.length / that._maxlen());
          for (var i = 0; i < pieces; i++) {
            finalobj[key+that._div+i] = val.substr(i*that._maxlen(), that._maxlen());
          }
        }
      }

      that._storageSet(finalobj, function() {
        if (callback) callback();
      });
    });
  },

  remove: function(arrayOfKeys, callback) {
    var that = this;
    if (typeof(arrayOfKeys) === 'string') {
      arrayOfKeys = [arrayOfKeys];
    }
    this._clearExisting(arrayOfKeys, callback);
  },

  // The default values or URLs for our various options.
  defaults: {
    'main-css': {'__defaultFromFile__': '/common/default.css', '__mimeType__': 'text/css'},
    'syntax-css': {'__defaultFromFile__': '/common/highlightjs/styles/github.css', '__mimeType__': 'text/css'},
    'math-enabled': false,
    'math-value': '<img src="https://chart.googleapis.com/chart?cht=tx&chl={urlmathcode}" alt="{mathcode}">',
    'hotkey': { shiftKey: false, ctrlKey: true, altKey: true, key: 'M' }
  },

  // Stored string pieces look like: {'key##0': 'the quick ', 'key##1': 'brown fox'}
  _div: '##',

  // HACK: Using the full length, or length-keylength, gives quota error.
  // Because
  _maxlen: function() {
    // Note that chrome.storage.sync.QUOTA_BYTES_PER_ITEM is in bytes, but JavaScript
    // strings are UTF-16, so we need to divide by 2.
    // Some JS string info: http://rosettacode.org/wiki/String_length#JavaScript
    if (chrome.storage) {
      return chrome.storage.sync.QUOTA_BYTES_PER_ITEM / 2;
    }
    else {
      // 2048 is the default value for chrome.storage.sync.QUOTA_BYTES_PER_ITEM, so...
      return 2048 / 2;
    }

  },

  _storageGet: function(callback) {
    if (chrome.storage) {
      chrome.storage.sync.get(null, function(obj) {
        var key;
        for (key in obj) {
          // Older settings aren't JSON-encoded, so they'll throw an exception.
          try {
            obj[key] = JSON.parse(obj[key]);
          }
          catch (ex) {
            // do nothing, leave the value as-is
          }
        }
        callback(obj);
      });
      return;
    }
    else {
      // Make this actually an async call.
      setTimeout(function() {
        var i, obj = {};
        for (i = 0; i < localStorage.length; i++) {
          // Older settings aren't JSON-encoded, so they'll throw an exception.
          try {
            obj[localStorage.key(i)] = JSON.parse(localStorage.getItem(localStorage.key(i)));
          }
          catch (ex) {
            obj[localStorage.key(i)] = localStorage.getItem(localStorage.key(i));
          }
        }
        callback(obj);
      });
      return;
    }
  },

  _storageSet: function(obj, callback) {
    var key, finalobj = {};
    for (key in obj) {
      finalobj[key] = JSON.stringify(obj[key]);
    }

    if (chrome.storage) {
      chrome.storage.sync.set(finalobj, callback);
      return;
    }
    else {
      // Make this actually an async call.
      setTimeout(function() {
        var key;
        for (key in finalobj) {
          localStorage.setItem(key, finalobj[key]);
        }
        if (callback) callback();
      });
      return;
    }
  },

  _storageRemove: function(keysToDelete, callback) {
    if (chrome.storage) {
      chrome.storage.sync.remove(keysToDelete, callback);
      return;
    }
    else {
      // Make this actually an async call.
      setTimeout(function() {
        var i;
        for (i = 0; i < keysToDelete.length; i++) {
          localStorage.removeItem(keysToDelete[i]);
        }
        callback();
      });
      return;
    }
  },

  // Clear any existing entries that match the given object's members.
  _clearExisting: function(obj, callback) {
    var that = this, newObj = {}, i;

    if (obj.constructor === Array) {
      newObj = {};
      for (i = 0; i < obj.length; i++) {
        newObj[obj[i]] = null;
      }
      obj = newObj;
    }

    this._storageGet(function(sync) {
      var keysToDelete = [];
      for (var objKey in obj) {
        for (var syncKey in sync) {
          if (syncKey === objKey || syncKey.indexOf(objKey+that._div) === 0) {
            keysToDelete.push(syncKey);
          }
        }
      }

      if (keysToDelete.length > 0) {
        that._storageRemove(keysToDelete, callback);
      }
      else {
        if (callback) callback();
      }
    });
  }
};

/*
 * Mozilla preferences storage helper
 */

var MozillaOptionsStore = {

  get: function(callback) {
    var that = this;
    this._sendRequest({action: 'get'}, function(prefsObj) {
      that._fillDefaults(prefsObj, callback);
    });
  },

  set: function(obj, callback) {
    this._sendRequest({action: 'set', obj: obj}, callback);
  },

  remove: function(arrayOfKeys, callback) {
    this._sendRequest({action: 'clear', obj: arrayOfKeys}, callback);
  },

  // The default values or URLs for our various options.
  defaults: {
    'main-css': {'__defaultFromFile__': 'resource://markdown_here_common/default.css', '__mimeType__': 'text/css'},
    'syntax-css': {'__defaultFromFile__': 'resource://markdown_here_common/highlightjs/styles/github.css', '__mimeType__': 'text/css'},
    'math-enabled': false,
    'math-value': '<img src="https://chart.googleapis.com/chart?cht=tx&chl={urlmathcode}" alt="{mathcode}">',
    'hotkey': { shiftKey: false, ctrlKey: true, altKey: true, key: 'M' },
    'local-first-run': true
  },

  // This is called both from content and background scripts, and we need vastly
  // different code in those cases. When calling from a content script, we need
  // to make a request to a background service (found in firefox/chrome/content/options.js).
  // When called from a background script, we're going to access the browser prefs
  // directly. Unfortunately, this means duplicating some code from the background
  // service.
  _sendRequest: function(data, callback) { // analogue of chrome.extension.sendRequest
    var prefs, prefKeys, prefsObj, request, sender, i;

    try {
      prefs = Components.classes['@mozilla.org/preferences-service;1']
                        .getService(Components.interfaces.nsIPrefService)
                        .getBranch('extensions.markdown-here.');

      if (data.action === 'get') {
        prefKeys = prefs.getChildList('');
        prefsObj = {};

        for (i = 0; i < prefKeys.length; i++) {
          prefsObj[prefKeys[i]] = JSON.parse(prefs.getCharPref(prefKeys[i]));
        }

        callback(prefsObj);
        return;
      }
      else if (data.action === 'set') {
        for (i in data.obj) {
          prefs.setCharPref(i, JSON.stringify(data.obj[i]));
        }

        if (callback) callback();
        return;
      }
      else if (data.action === 'clear') {
        if (typeof(data.obj) === 'string') {
          data.obj = [data.obj];
        }

        for (i = 0; i < data.obj.length; i++) {
          prefs.clearUserPref(data.obj[i]);
        }

        if (callback) return callback();
        return;
      }
    }
    catch (ex) {
      request = document.createTextNode('');
      request.setUserData('data', data, null);
      if (callback) {
        request.setUserData('callback', callback, null);

        var optionsResponseHandler = function(event) {
          var node, callback, response;
          node = event.target;
          callback = node.getUserData('callback');

          // May be undefined if there is no response data.
          response = node.getUserData('response');

          document.documentElement.removeChild(node);
          // Note that if there's no callback, then the node gets removed by
          // background service: firefox/chrome/content/options.js:listenRequest()
          // TODO: That's pretty badly hacky. Can we do the node removal after
          // the `dispatchEvent()` call below?

          document.removeEventListener('markdown_here-options-response', optionsResponseHandler, false);

          // We need to return a clone of the response.
          // This is because the response came from the background script, and
          // if later content-script code tries to modify it, an error will
          // result (silently). I belive that this is related to
          // `__exposedProps__` -- see `addExposedProps()` for details.
          if (response) {
            response = JSON.parse(JSON.stringify(response));
          }

          callback(response);
          return;
        };

        document.addEventListener('markdown_here-options-response', optionsResponseHandler, false);
      }
      document.documentElement.appendChild(request);

      sender = document.createEvent('HTMLEvents');
      sender.initEvent('markdown_here-options-query', true, false);
      request.dispatchEvent(sender);
    }
  }
};


var SafariOptionsStore = {

  // The options object will be passed to `callback`
  get: function(callback) {
    var that = this;
    // Make this actually asynchronous
    setTimeout(function() {
      that._fillDefaults(safari.extension.settings, callback);
    });
  },

  // Store `obj`. `callback` will be called (with no arguments) when complete.
  set: function(obj, callback) {
    for (var key in obj) {
      safari.extension.settings[key] = obj[key];
    }

    // Make this actually asynchronous
    setTimeout(function() {
      if (callback) callback();
    });
  },

  remove: function(arrayOfKeys, callback) {
    var i;

    if (typeof(arrayOfKeys) === 'string') {
      arrayOfKeys = [arrayOfKeys];
    }

    for (i = 0; i < arrayOfKeys.length; i++) {
      delete safari.extension.settings[arrayOfKeys[i]];
    }

    // Make this actually asynchronous
    setTimeout(function() {
      if (callback) callback();
    });
  },

  // The default values or URLs for our various options.
  defaults: {
    'main-css': {'__defaultFromFile__': 'common/default.css', '__mimeType__': 'text/css'},
    'syntax-css': {'__defaultFromFile__': 'common/highlightjs/styles/github.css', '__mimeType__': 'text/css'},
    'math-enabled': false,
    'math-value': '<img src="https://chart.googleapis.com/chart?cht=tx&chl={urlmathcode}" alt="{mathcode}">',
    'hotkey': { shiftKey: false, ctrlKey: true, altKey: true, key: 'M' }
  }
};


if (typeof(navigator) !== 'undefined' && navigator.userAgent.indexOf('Chrome') >= 0) {
  this.OptionsStore = ChromeOptionsStore;
}
else if (typeof(navigator) !== 'undefined' && navigator.userAgent.match(/AppleWebKit.*Version.*Safari/)) {
  this.OptionsStore = SafariOptionsStore;
}
else {
  this.OptionsStore = MozillaOptionsStore;
}

this.OptionsStore._fillDefaults = function(prefsObj, callback) {
  var that = this;

  var key, allKeys = [];
  for (key in that.defaults) {
    if (that.defaults.hasOwnProperty(key)) {
      allKeys.push(key);
    }
  }

  doNextKey();

  function doNextKey() {
    if (allKeys.length === 0) {
      // All done
      return callback(prefsObj);
    }

    // Keep processing keys (and recurse)
    return doDefaultForKey(allKeys.pop(), doNextKey);
  }

  function doDefaultForKey(key, callback) {
    // Only take action if the key doesn't already have a value set.
    if (typeof(prefsObj[key]) === 'undefined') {
      if (that.defaults[key].hasOwnProperty('__defaultFromFile__')) {
        var xhr = new XMLHttpRequest();

        if (that.defaults[key]['__mimeType__']) {
          xhr.overrideMimeType(that.defaults[key]['__mimeType__']);
        }

        // Get the default value from the indicated file.
        xhr.open('GET', that.defaults[key]['__defaultFromFile__']);

        xhr.onreadystatechange = function() {
          if (this.readyState === this.DONE) {
            // Assume 200 OK -- it's just a local call
            prefsObj[key] = this.responseText;

            return callback();
          }
        };

        xhr.send();
      }
      else {
        // Make it actually asynchronous
        setTimeout(function() {
          prefsObj[key] = that.defaults[key];
          return callback();
        });
      }
    }
    else {
      // Just skip it, but make it asynchronous
      setTimeout(function() {
        return callback();
      });
    }
  }
};

var EXPORTED_SYMBOLS = ['OptionsStore'];
this.EXPORTED_SYMBOLS = EXPORTED_SYMBOLS;

}).call(function() {
  return this || (typeof window !== 'undefined' ? window : global);
}());
