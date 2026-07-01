/**
 * EmojiPicker Web Component
 * Standalone emoji picker component
 * 
 * Usage:
 * <emoji-picker></emoji-picker>
 * 
 * Events:
 * - emoji-select: Fired when user selects an emoji, detail contains { emoji }
 * - picker-open: Fired when the popup opens
 * - picker-close: Fired when the popup closes
 * 
 * Methods:
 * - open(): Open the emoji picker popup
 * - close(): Close the emoji picker popup
 * - toggle(): Toggle the popup visibility
 */

const EMOJI_PICKER_STYLES = `
:host {
  display: inline-block;
}

.emoji-btn {
  height: 32px;
  width: 32px;
  padding: 0;
  font-size: 14px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background-color: #FF9800;
  color: white;
  margin: 0;
  font-family: inherit;
}

.emoji-btn:hover {
  opacity: 0.9;
  transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.emoji-btn:disabled {
  background-color: #cccccc;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

.emoji-btn .icon {
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
}

.emoji-picker-overlay {
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0,0,0,0.5);
  z-index: 800; /* Peershould --z-shadow-backdrop */
}

.emoji-picker-overlay.open {
  display: block;
}

/* tableselectorPeerdialog (useUnified standard: --z-shadow-modal) */
.emoji-picker-dialog {
  display: none;
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: white;
  padding: 20px;
  border: 1px solid #ccc;
  border-radius: 8px;
  z-index: 900; /* Peershould --z-shadow-modal */
  box-shadow: 0 2px 10px rgba(0,0,0,0.1);
  min-width: 320px;
}

.emoji-picker-dialog.open {
  display: block;
}

.emoji-picker-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.emoji-picker-header h3 {
  margin: 0;
  font-size: 16px;
  color: #333;
}

.emoji-picker-close {
  background: none;
  border: none;
  font-size: 20px;
  cursor: pointer;
  padding: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.emoji-picker-close:hover {
  background-color: #f0f0f0;
}

.emoji-list {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 8px;
  max-height: 300px;
  overflow-y: auto;
  padding: 10px;
}

.emoji-item {
  font-size: 24px;
  cursor: pointer;
  padding: 5px;
  border-radius: 4px;
  transition: background-color 0.2s;
  text-align: center;
  user-select: none;
}

.emoji-item:hover {
  background-color: #f0f0f0;
}

/* Scrollbar style */
.emoji-list::-webkit-scrollbar {
  width: 6px;
}

.emoji-list::-webkit-scrollbar-track {
  background: #f1f1f1;
  border-radius: 3px;
}

.emoji-list::-webkit-scrollbar-thumb {
  background: #c1c1c1;
  border-radius: 3px;
}

.emoji-list::-webkit-scrollbar-thumb:hover {
  background: #a8a8a8;
}
`;

// Common emoji list
const DEFAULT_EMOJIS = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣',
  '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰',
  '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜',
  '🤪', '🤨', '🧐', '🤓', '😎', '🥸', '🤩', '🥳',
  '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️',
  '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤',
  '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱',
  '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫',
  '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😦',
  '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵',
  '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕',
  '🤑', '🤠', '😈', '👿', '👹', '👺', '🤡', '💩',
  '👻', '💀', '☠️', '👽', '👾', '🤖', '🎃', '😺',
  '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍',
  '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖',
  '👍', '👎', '👏', '🙌', '🤝', '👊', '✊', '🤛',
  '🤜', '🤞', '✌️', '🤟', '🤘', '👌', '🤏', '👈',
  '👉', '👆', '👇', '☝️', '✋', '🤚', '🖐️', '🖖',
  '👋', '🤙', '💪', '🦾', '🖕', '✍️', '🙏', '🦶',
  '🦵', '🦿', '👂', '🦻', '👃', '🧠', '🦷', '🦴',
  '👀', '👁️', '👅', '👄', '💋', '🩸', '🌹', '🌺',
  '🌻', '🌼', '🌷', '🌲', '🌳', '🌴', '🌵', '🌾',
  '🌿', '☘️', '🍀', '🍁', '🍂', '🍃', '🍄', '🌰',
  '🦀', '🦞', '🦐', '🦑', '🌍', '🌎', '🌏', '🌐',
  '🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘',
  '🌙', '🌚', '🌛', '🌜', '☀️', '🌝', '🌞', '⭐',
  '🌟', '🌠', '☁️', '⛅', '⛈️', '🌤️', '🌥️', '🌦️',
  '🌧️', '🌨️', '🌩️', '🌪️', '🌫️', '🌬️', '🌀', '🌈',
  '🌂', '☂️', '☔', '⛱️', '⚡', '❄️', '☃️', '⛄',
  '☄️', '🔥', '💧', '🌊', '🎄', '✨', '🎋', '🎍'
];

export class EmojiPicker extends HTMLElement {
  static get observedAttributes() {
    return ['button-text', 'button-icon', 'disabled'];
  }

  constructor() {
    super();
    this._isOpen = false;
    this._emojis = [...DEFAULT_EMOJIS];
    this._buttonText = '';
    this._buttonIcon = '😊';
    this._disabled = false;

    this.attachShadow({ mode: 'open' });
    this.render();
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>${EMOJI_PICKER_STYLES}</style>
      <button class="emoji-btn" part="button">
        <span class="icon">${this._buttonIcon}</span>
        <span class="text">${this._buttonText}</span>
      </button>
      <div class="emoji-picker-overlay" part="overlay"></div>
      <div class="emoji-picker-dialog" part="dialog">
        <div class="emoji-picker-header">
          <h3>Emoji</h3>
          <button class="emoji-picker-close">×</button>
        </div>
        <div class="emoji-list" part="emoji-list"></div>
      </div>
    `;

    this._bindEvents();
    this._renderEmojis();
  }

  _bindEvents() {
    const btn = this.shadowRoot.querySelector('.emoji-btn');
    const overlay = this.shadowRoot.querySelector('.emoji-picker-overlay');
    const closeBtn = this.shadowRoot.querySelector('.emoji-picker-close');

    btn.addEventListener('click', () => this.toggle());
    overlay.addEventListener('click', () => this.close());
    closeBtn.addEventListener('click', () => this.close());

    // Close on ESC key
    this._handleKeydown = (e) => {
      if (e.key === 'Escape' && this._isOpen) {
        this.close();
      }
    };
    document.addEventListener('keydown', this._handleKeydown);
  }

  _renderEmojis() {
    const emojiList = this.shadowRoot.querySelector('.emoji-list');
    emojiList.innerHTML = '';

    this._emojis.forEach(emoji => {
      const emojiItem = document.createElement('div');
      emojiItem.className = 'emoji-item';
      emojiItem.textContent = emoji;
      emojiItem.setAttribute('role', 'button');
      emojiItem.setAttribute('tabindex', '0');
      emojiItem.setAttribute('aria-label', `Emoji ${emoji}`);

      emojiItem.addEventListener('click', () => this._onEmojiSelect(emoji));
      emojiItem.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this._onEmojiSelect(emoji);
        }
      });

      emojiList.appendChild(emojiItem);
    });
  }

  _onEmojiSelect(emoji) {
    this.dispatchEvent(new CustomEvent('emoji-select', {
      detail: { emoji },
      bubbles: true,
      composed: true
    }));
    this.close();
  }

  // Public methods
  open() {
    if (this._disabled) return;
    this._isOpen = true;
    this.shadowRoot.querySelector('.emoji-picker-overlay').classList.add('open');
    this.shadowRoot.querySelector('.emoji-picker-dialog').classList.add('open');
    this.dispatchEvent(new CustomEvent('picker-open', {
      bubbles: true,
      composed: true
    }));
  }

  close() {
    this._isOpen = false;
    this.shadowRoot.querySelector('.emoji-picker-overlay').classList.remove('open');
    this.shadowRoot.querySelector('.emoji-picker-dialog').classList.remove('open');
    this.dispatchEvent(new CustomEvent('picker-close', {
      bubbles: true,
      composed: true
    }));
  }

  toggle() {
    if (this._isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  // Attribute handling
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;

    switch (name) {
      case 'button-text':
        this._buttonText = newValue || '';
        const textEl = this.shadowRoot.querySelector('.emoji-btn .text');
        if (textEl) textEl.textContent = this._buttonText;
        break;
      case 'button-icon':
        this._buttonIcon = newValue || '😊';
        const iconEl = this.shadowRoot.querySelector('.emoji-btn .icon');
        if (iconEl) iconEl.textContent = this._buttonIcon;
        break;
      case 'disabled':
        this._disabled = newValue !== null;
        const btn = this.shadowRoot.querySelector('.emoji-btn');
        if (btn) btn.disabled = this._disabled;
        break;
    }
  }

  // Getter/Setter
  get isOpen() {
    return this._isOpen;
  }

  get emojis() {
    return [...this._emojis];
  }

  set emojis(value) {
    if (Array.isArray(value)) {
      this._emojis = value;
      this._renderEmojis();
    }
  }

  disconnectedCallback() {
    document.removeEventListener('keydown', this._handleKeydown);
  }
}

// Register component
customElements.define('emoji-picker', EmojiPicker);
