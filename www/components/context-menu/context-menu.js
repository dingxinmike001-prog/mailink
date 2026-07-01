/**
 * Context menu component
 * used to display a custom context menu
 */

export class ContextMenu {
  constructor() {
    this.menuElement = null;
    this.isVisible = false;
    this.onMenuAction = null;
  }

  /**
   * Show context menu
   * @param {number} x - menu display X coordinate
   * @param {number} y - menu display Y coordinate
   * @param {Array} items - menu item array
   * @param {Object} context - context data
   */
  show(x, y, items, context) {
    // If a menu already exists, remove it first
    this.hide();

    // Create menu element
    this.menuElement = document.createElement('div');
    this.menuElement.className = 'context-menu';
    this.menuElement.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      background: white;
      border: 1px solid #ddd;
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      z-index: 10900; /* Corresponds to --z-light-context-menu */
      min-width: 150px;
      padding: 4px 0;
    `;

    // Add menu items
    items.forEach(item => {
      const menuItem = document.createElement('div');
      menuItem.className = 'context-menu-item';
      menuItem.textContent = item.label;
      menuItem.style.cssText = `
        padding: 8px 16px;
        cursor: pointer;
        font-size: 14px;
        color: #333;
        transition: background 0.2s;
      `;

      // Hover effect
      menuItem.addEventListener('mouseenter', () => {
        menuItem.style.background = '#f5f5f5';
      });
      menuItem.addEventListener('mouseleave', () => {
        menuItem.style.background = 'transparent';
      });

      // Click event
      menuItem.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.hide();
        if (this.onMenuAction) {
          this.onMenuAction(item.action, context);
        }
      });

      this.menuElement.appendChild(menuItem);
    });

    // Append to document
    document.body.appendChild(this.menuElement);
    this.isVisible = true;

    // Click elsewhere to close the menu
    setTimeout(() => {
      document.addEventListener('click', this.handleClickOutside);
      document.addEventListener('contextmenu', this.handleClickOutside);
    }, 0);

    // Adjust menu position so it doesn't exceed the viewport
    this.adjustPosition();
  }

  /**
   * Hide context menu
   */
  hide() {
    if (this.menuElement) {
      this.menuElement.remove();
      this.menuElement = null;
      this.isVisible = false;
      document.removeEventListener('click', this.handleClickOutside);
      document.removeEventListener('contextmenu', this.handleClickOutside);
    }
  }

  /**
   * Handle clicking outside to close menu
   */
  handleClickOutside = (e) => {
    if (this.menuElement && !this.menuElement.contains(e.target)) {
      this.hide();
    }
  }

  /**
   * adjust menu position, ensure doesn't exceed viewport
   */
  adjustPosition() {
    if (!this.menuElement) return;

    const rect = this.menuElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // If the menu exceeds the right boundary, adjust it to the left
    if (rect.right > viewportWidth) {
      this.menuElement.style.left = `${viewportWidth - rect.width - 10}px`;
    }

    // If the menu exceeds the bottom boundary, adjust it upward
    if (rect.bottom > viewportHeight) {
      this.menuElement.style.top = `${viewportHeight - rect.height - 10}px`;
    }
  }

  /**
   * Set menu action callback
   * @param {Function} callback - callback function
   */
  setOnMenuAction(callback) {
    this.onMenuAction = callback;
  }
}
