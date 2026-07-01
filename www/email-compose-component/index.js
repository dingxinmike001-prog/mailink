/**
 * Email composing component
 * Uses TinyMCE rich text editor
 * Uses Light DOM (does not use Shadow DOM)
 */

import { playCloseAnimation, playOpenAnimation } from '../shared/close-animation.js';

async function loadTinyMCE() {
    if (window.tinymce) return window.tinymce;

    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/tinymce@7/tinymce.min.js';
        script.onload = () => resolve(window.tinymce);
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

async function loadTemplate() {
    try {
        const htmlUrl = new URL('./email-compose.html', import.meta.url).href;
        const response = await fetch(htmlUrl);
        if (response.ok) {
            return await response.text();
        }
        console.warn('[MailinkEmailCompose] Failed to load HTML template');
        return '';
    } catch (error) {
        console.warn('[MailinkEmailCompose] Error loading HTML template:', error);
        return '';
    }
}

export class MailinkEmailCompose extends HTMLElement {
    constructor() {
        super();
        this._originalEmail = null;
        this._isVisible = false;
        this._isSending = false;
        this._isNewEmail = false;
        this._editor = null;
        this._editorInitialized = false;
        this._editorInitResolver = null;
        this._initialized = false;
        this._tinymceDialogOpen = false;
        this._attachments = [];
        // Recipient Chips related data
        this._toChips = [];
        this._toSuggestions = [];
        this._currentToSuggestionIndex = -1;
        // Sender Chips related data
        this._fromChips = [];
        this._fromSuggestions = [];
        this._currentFromSuggestionIndex = -1;
        // Contact data
        this._allContacts = [];           // All contacts cache
        this._contactsLoaded = false;     // Whether contacts have been loaded
        this._toInputDebounceTimer = null; // Search debounce timer
        this._currentLoginUsername = null; // Currently logged-in user
    }

    async connectedCallback() {
        if (this._initialized) return;

        const [cssContent, htmlContent] = await Promise.all([
            this._loadCSS(),
            loadTemplate()
        ]);

        const styleElement = document.createElement('style');
        styleElement.id = 'email-compose-styles';
        styleElement.textContent = cssContent;
        this.appendChild(styleElement);

        const templateElement = document.createElement('template');
        templateElement.innerHTML = htmlContent;
        this.appendChild(templateElement.content.cloneNode(true));

        if (window.i18n?.registerRoot) window.i18n.registerRoot(this);
        
        // Wait for i18n to be ready before initializing translation to avoid timing issues
        if (window.i18n?.whenReady) {
            await window.i18n.whenReady();
        }
        if (window.i18n?.initElements) window.i18n.initElements(this);

        this._handleLangChanged = () => {
            if (window.i18n?.initElements) window.i18n.initElements(this);
        };
        window.addEventListener('lang-changed', this._handleLangChanged);

        this._bindEvents();
        this._initialized = true;

        console.log('[MailinkEmailCompose] Component initialized (Light DOM)');
    }

    async _loadCSS() {
        try {
            const cssUrl = new URL('./email-compose.css', import.meta.url).href;
            const response = await fetch(cssUrl);
            if (response.ok) {
                return await response.text();
            }
            console.warn('[MailinkEmailCompose] Failed to load CSS');
            return '';
        } catch (error) {
            console.warn('[MailinkEmailCompose] Error loading CSS:', error);
            return '';
        }
    }

    async _initEditor() {
        if (this._editorInitialized) return;

        try {
            const tinymce = await loadTinyMCE();
            const editorElement = this.querySelector('#tinymceEditor');

            if (!editorElement) {
                console.error('[MailinkEmailCompose] Editor element not found');
                return;
            }

            const self = this;

            // Create a Promise that waits for the editor to finish initializing
            const editorInitPromise = new Promise((resolve) => {
                self._editorInitResolver = resolve;
            });

            await tinymce.init({
                target: editorElement,
                height: 300,
                menubar: false,
                z_index: 110000,
                plugins: [
                    'advlist', 'autolink', 'lists', 'link', 'image', 'charmap', 'preview',
                    'anchor', 'searchreplace', 'visualblocks', 'code', 'fullscreen',
                    'insertdatetime', 'media', 'table', 'help', 'wordcount', 'emoticons'
                ],
                toolbar: 'undo redo | blocks fontfamily fontsize | bold italic underline strikethrough | ' +
                    'alignleft aligncenter alignright alignjustify | ' +
                    'bullist numlist outdent indent | link image media table emoticons | ' +
                    'forecolor backcolor removeformat | charmap code fullscreen preview | help',
                toolbar_sticky: true,
                toolbar_mode: 'sliding',
                content_style: 'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; font-size: 14px; line-height: 1.6; }',
                placeholder: window.i18n?.t('emailCompose.contentPlaceholder') || 'Enter email content here...',
                branding: false,
                promotion: false,
                resize: false,
                statusbar: true,
                elementpath: false,
                wordcount_countregex: /[\u4e00-\u9fa5_a-zA-Z0-9]+/g,
                setup: function(editor) {
                    self._editor = editor;
                    editor.on('init', function() {
                        console.log('[MailinkEmailCompose] TinyMCE editor initialized');
                        self._editorInitialized = true;
                        if (self._editorInitResolver) {
                            self._editorInitResolver();
                            self._editorInitResolver = null;
                        }
                    });
                    editor.on('OpenWindow', function(e) {
                        console.log('[MailinkEmailCompose] TinyMCE dialog opened:', e.dialog?.getData?.() || 'unknown');
                        self._tinymceDialogOpen = true;
                    });
                    editor.on('CloseWindow', function() {
                        console.log('[MailinkEmailCompose] TinyMCE dialog closed');
                        self._tinymceDialogOpen = false;
                    });
                    editor.on('click', function(e) {
                        console.log('[MailinkEmailCompose] TinyMCE toolbar button clicked:', e.target?.nodeName);
                    });

                    // Prevent TinyMCE from handling dragged and dropped files (let the attachment system handle it)
                    editor.on('dragover', function(e) {
                        // If a file is being dragged, prevent TinyMCE from handling it
                        if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
                            e.preventDefault();
                            e.stopPropagation();
                        }
                    });

                    editor.on('drop', function(e) {
                        // If the dragged item is a file, prevent TinyMCE from inserting it into the editor
                        if (e.dataTransfer && e.dataTransfer.files.length > 0) {
                            e.preventDefault();
                            e.stopPropagation();
                            console.log('[MailinkEmailCompose] TinyMCE drop prevented for file attachment');
                        }
                    });
                }
            });

            // Wait for the editor initialization event to trigger
            await editorInitPromise;

        } catch (error) {
            console.error('[MailinkEmailCompose] Failed to initialize TinyMCE:', error);
        }
    }

    _bindEvents() {
        // Bind click event to popup and check position constraints
        const modal = this.querySelector('#composeModal');
        if (modal) {
            modal.addEventListener('click', () => {
                this._enforcePositionLimit();
            });
        }

        const closeBtn = this.querySelector('#composeCloseBtn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.close());
        }

        const cancelBtn = this.querySelector('#cancelComposeBtn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => this.close());
        }

        const overlay = this.querySelector('#composeOverlay');
        if (overlay) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) this.close();
            });
        }

        const sendBtn = this.querySelector('#sendComposeBtn');
        if (sendBtn) {
            sendBtn.addEventListener('click', () => this._sendEmail());
        }

        const addAttachmentBtn = this.querySelector('#addAttachmentBtn');
        const attachmentInput = this.querySelector('#attachmentInput');
        if (addAttachmentBtn && attachmentInput) {
            addAttachmentBtn.addEventListener('click', () => attachmentInput.click());
            attachmentInput.addEventListener('change', (e) => this._handleFileSelect(e));
        }

        // Bind recipient Chips input event
        const toChipsInput = this.querySelector('#toChipsInput');
        const toChipsField = this.querySelector('#toChipsField');
        const toChipsSuggestions = this.querySelector('#toChipsSuggestions');
        if (toChipsInput && toChipsField) {
            toChipsInput.addEventListener('keydown', (e) => this._handleToChipsKeydown(e));
            toChipsInput.addEventListener('input', (e) => this._handleToChipsInputDebounce(e));
            toChipsInput.addEventListener('paste', (e) => this._handleToChipsPaste(e));
            toChipsInput.addEventListener('blur', () => this._handleToChipsBlur());
            toChipsInput.addEventListener('focus', () => {
                // Show suggestions when there is search text while focusing
                const value = toChipsInput.value.trim();
                if (value && this._toSuggestions.length > 0) {
                    this._showToSuggestionsEnhanced();
                }
            });
            toChipsField.addEventListener('click', () => toChipsInput.focus());
        }

        // Bind the suggestion item click event (event delegation)
        if (toChipsSuggestions) {
            toChipsSuggestions.addEventListener('click', (e) => {
                console.log('[MailinkEmailCompose] Suggestion container clicked', {
                    target: e.target,
                    targetClass: e.target.className,
                    bubbles: e.bubbles
                });
                
                const item = e.target.closest('.email-compose-suggestion-item');
                console.log('[MailinkEmailCompose] Closest suggestion item:', item);
                
                if (!item) {
                    console.warn('[MailinkEmailCompose] No suggestion item found in click target');
                    return;
                }

                const email = item.getAttribute('data-email');
                console.log('[MailinkEmailCompose] Suggestion email:', email);
                
                if (email) {
                    console.log('[MailinkEmailCompose] Adding chip for:', email);
                    const result = this._addToChip(email);
                    console.log('[MailinkEmailCompose] Add chip result:', result);
                    
                    const input = this.querySelector('#toChipsInput');
                    if (input) {
                        input.value = '';
                        input.focus();
                    }
                    this._hideToSuggestions();
                } else {
                    console.warn('[MailinkEmailCompose] No email attribute found on suggestion item');
                }
            });
        }

        // Bind sender Chips input event
        const fromChipsInput = this.querySelector('#fromChipsInput');
        const fromChipsField = this.querySelector('#fromChipsField');
        if (fromChipsInput && fromChipsField) {
            fromChipsInput.addEventListener('keydown', (e) => this._handleFromChipsKeydown(e));
            fromChipsInput.addEventListener('input', (e) => this._handleFromChipsInput(e));
            fromChipsInput.addEventListener('paste', (e) => this._handleFromChipsPaste(e));
            fromChipsInput.addEventListener('blur', () => this._handleFromChipsBlur());
            fromChipsField.addEventListener('click', () => fromChipsInput.focus());
        }

        this._handleEscKey = (e) => {
            if (e.key === 'Escape' && this._isVisible && !this._tinymceDialogOpen) {
                this.close();
            }
        };
        document.addEventListener('keydown', this._handleEscKey);

        // Bind drag-and-drop events
        this._bindDragDropEvents();
    }

    /**
     * Check whether the file is a web-displayable image format
     * Supports determination via MIME type or file extension
     */
    _isWebImage(file) {
        // First, check the MIME type
        const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp'];
        if (imageTypes.includes(file.type.toLowerCase())) {
            return true;
        }
        // If the MIME type does not match, check the file extension
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
        const fileName = file.name.toLowerCase();
        return imageExtensions.some(ext => fileName.endsWith(ext));
    }

    /**
     * Check from dataTransfer.items whether it is an image file
     * Used to make an early judgment during the dragenter event
     */
    _detectImageFromDataTransfer(dataTransfer) {
        // Try to get type information from items
        if (dataTransfer.items && dataTransfer.items.length > 0) {
            const item = dataTransfer.items[0];
            if (item.type && item.type.startsWith('image/')) {
                return true;
            }
        }
        // Try to determine from types
        if (dataTransfer.types) {
            for (const type of dataTransfer.types) {
                if (type.startsWith('image/')) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Bind drag-and-drop file upload event
     */
    _bindDragDropEvents() {
        const dropZone = this.querySelector('#dropZone');
        const dropOverlay = this.querySelector('#dropOverlay');
        const dropSectionEditor = this.querySelector('#dropSectionEditor');
        const dropSectionAttachment = this.querySelector('#dropSectionAttachment');
        const composeOverlay = this.querySelector('#composeOverlay');
        const composeModal = this.querySelector('#composeModal');

        if (!dropZone || !dropOverlay || !composeOverlay) {
            console.warn('[MailinkEmailCompose] Drag drop elements not found');
            return;
        }

        let dragCounter = 0;
        let isDragging = false;
        let isImageFile = false;
        let currentDropTarget = null; // 'editor' or 'attachment'

        // Prevent the default behavior (prevent the browser from opening the file, but do not stop event bubbling)
        const preventDefaults = (e) => {
            e.preventDefault();
            // Do not call stopPropagation so the event can continue to propagate
        };

        // Prevent the default drag-and-drop behavior on composeOverlay (but do not stop propagation)
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            composeOverlay.addEventListener(eventName, preventDefaults, false);
        });

        // Listen for drag-and-drop events in a larger area of composeModal (instead of only in dropZone)
        composeModal.addEventListener('dragenter', (e) => {
            dragCounter++;

            // Check if it is a file drag
            if (e.dataTransfer.types.includes('Files')) {
                isDragging = true;

                // Check if it is an image file (using dataTransfer to detect in advance)
                isImageFile = this._detectImageFromDataTransfer(e.dataTransfer);

                // Show different floating layer based on file type
                if (isImageFile) {
                    // Display floating layers for the upper and lower parts
                    dropOverlay.classList.remove('attachment-only');
                    dropOverlay.classList.add('active');
                    if (dropSectionEditor) dropSectionEditor.style.display = 'flex';
                    if (dropSectionAttachment) dropSectionAttachment.style.display = 'flex';
                    console.log('[MailinkEmailCompose] Image file drag detected, showing dual sections');
                } else {
                    // Non-image file, only display the attachment part (filling the entire area)
                    dropOverlay.classList.add('attachment-only');
                    dropOverlay.classList.add('active');
                    if (dropSectionEditor) dropSectionEditor.style.display = 'none';
                    if (dropSectionAttachment) {
                        dropSectionAttachment.style.display = 'flex';
                        dropSectionAttachment.style.flex = '1';
                    }
                    console.log('[MailinkEmailCompose] Non-image file drag detected, showing attachment only');
                }

                dropZone.classList.add('drag-over');
            }
        });

        // Drag out of the popup area
        composeModal.addEventListener('dragleave', (e) => {
            dragCounter--;

            // Only hide when actually leaving the area (not when entering a child element)
            if (dragCounter <= 0) {
                dragCounter = 0;
                isDragging = false;
                isImageFile = false;
                currentDropTarget = null;
                dropOverlay.classList.remove('active');
                dropOverlay.classList.remove('attachment-only');
                dropZone.classList.remove('drag-over');
                if (dropSectionEditor) dropSectionEditor.classList.remove('drag-over');
                if (dropSectionAttachment) {
                    dropSectionAttachment.classList.remove('drag-over');
                    dropSectionAttachment.style.flex = '';
                }
                console.log('[MailinkEmailCompose] File drag left');
            }
        });

        // Drag and hover (default behavior must be prevented to trigger drop)
        composeModal.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });

        // Listen for drag movements in various areas of the floating layer
        if (dropSectionEditor) {
            dropSectionEditor.addEventListener('dragenter', (e) => {
                e.preventDefault();
                currentDropTarget = 'editor';
                dropSectionEditor.classList.add('drag-over');
                dropSectionAttachment.classList.remove('drag-over');
                console.log('[MailinkEmailCompose] Drag over editor section');
            });

            dropSectionEditor.addEventListener('dragleave', (e) => {
                // Only remove the highlight when actually leaving the area
                if (!dropSectionEditor.contains(e.relatedTarget)) {
                    dropSectionEditor.classList.remove('drag-over');
                }
            });
        }

        if (dropSectionAttachment) {
            dropSectionAttachment.addEventListener('dragenter', (e) => {
                e.preventDefault();
                currentDropTarget = 'attachment';
                dropSectionAttachment.classList.add('drag-over');
                dropSectionEditor?.classList.remove('drag-over');
                console.log('[MailinkEmailCompose] Drag over attachment section');
            });

            dropSectionAttachment.addEventListener('dragleave', (e) => {
                if (!dropSectionAttachment.contains(e.relatedTarget)) {
                    dropSectionAttachment.classList.remove('drag-over');
                }
            });
        }

        // Place files - Use event capture to handle first on dropZone
        const handleDrop = (e) => {
            // Stop the event from propagating further (to prevent TinyMCE from handling images)
            e.stopPropagation();
            e.preventDefault();

            // If it has already been processed, return directly
            if (e._dropHandled) {
                return;
            }
            e._dropHandled = true;

            console.log('[MailinkEmailCompose] Drop event triggered on:', e.target.id || e.target.className, 'target:', currentDropTarget);

            // Reset state
            dragCounter = 0;
            isDragging = false;
            dropOverlay.classList.remove('active');
            dropOverlay.classList.remove('attachment-only');
            dropZone.classList.remove('drag-over');
            if (dropSectionEditor) dropSectionEditor.classList.remove('drag-over');
            if (dropSectionAttachment) {
                dropSectionAttachment.classList.remove('drag-over');
                dropSectionAttachment.style.flex = '';
            }

            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                // Recheck whether the first file is an image (more accurate detection)
                const firstFileIsImage = this._isWebImage(files[0]);
                console.log(`[MailinkEmailCompose] Dropped ${files.length} file(s), target: ${currentDropTarget}, isImage: ${firstFileIsImage}`);

                // Determine the handling method based on the release location
                if (firstFileIsImage && currentDropTarget === 'editor') {
                    // Insert into rich text editor
                    this._handleDroppedImagesToEditor(files);
                } else {
                    // Add to attachments (non-image files or drag to the attachment area)
                    this._handleDroppedFiles(files);
                }
            } else {
                console.log('[MailinkEmailCompose] No files in drop event');
            }

            // Reset state
            isImageFile = false;
            currentDropTarget = null;
        };

        // Use capture phase listening on dropZone to ensure it handles events before TinyMCE
        dropZone.addEventListener('drop', handleDrop, true);

        // At the same time, listen on composeOverlay as a fallback
        composeOverlay.addEventListener('drop', handleDrop, true);

        // Global drag enter (used to handle dragging in from external sources)
        composeOverlay.addEventListener('dragenter', (e) => {
            if (e.dataTransfer.types.includes('Files')) {
                // Check whether the drag target is within the editor area
                const relatedTarget = e.relatedTarget;
                if (!dropZone.contains(relatedTarget) && !isDragging) {
                    dragCounter++;
                    isDragging = true;

                    // Check if it is an image file
                    isImageFile = this._detectImageFromDataTransfer(e.dataTransfer);

                    // Show different floating layer based on file type
                    if (isImageFile) {
                        dropOverlay.classList.remove('attachment-only');
                        dropOverlay.classList.add('active');
                        if (dropSectionEditor) dropSectionEditor.style.display = 'flex';
                        if (dropSectionAttachment) dropSectionAttachment.style.display = 'flex';
                        console.log('[MailinkEmailCompose] Global image drag enter');
                    } else {
                        dropOverlay.classList.add('attachment-only');
                        dropOverlay.classList.add('active');
                        if (dropSectionEditor) dropSectionEditor.style.display = 'none';
                        if (dropSectionAttachment) {
                            dropSectionAttachment.style.display = 'flex';
                            dropSectionAttachment.style.flex = '1';
                        }
                        console.log('[MailinkEmailCompose] Global non-image drag enter');
                    }

                    dropZone.classList.add('drag-over');
                }
            }
        });

        console.log('[MailinkEmailCompose] Drag drop events bound');
    }

    /**
     * Handle dragged and dropped image files - insert into rich text editor
     */
    _handleDroppedImagesToEditor(files) {
        for (const file of files) {
            if (!this._isWebImage(file)) {
                // Non-image file, treat as attachment
                this._handleDroppedFiles([file]);
                continue;
            }

            const maxSize = 10 * 1024 * 1024; // The image inserted into the editor is limited to 10MB
            if (file.size > maxSize) {
                this._showStatus((window.i18n?.t('emailCompose.imageSizeLimit') || 'image "{name}" exceed10MBlimit，converted to attachment').replace('{name}', file.name), 'error');
                this._handleDroppedFiles([file]);
                continue;
            }

            // Read the image and insert it into the editor
            const reader = new FileReader();
            reader.onload = (e) => {
                const base64Data = e.target.result;
                if (this._editor && this._editorInitialized) {
                    // Insert image at the current cursor position in the editor
                    this._editor.insertContent(`<img src="${base64Data}" alt="${file.name}" style="max-width: 100%; height: auto;" />`);
                    console.log(`[MailinkEmailCompose] Image inserted to editor: ${file.name}`);
                } else {
                    this._showStatus(window.i18n?.t('emailCompose.editorNotReady') || 'Editor not ready，Image converted to attachment', 'error');
                    this._handleDroppedFiles([file]);
                }
            };
            reader.onerror = () => {
                console.error(`[MailinkEmailCompose] Failed to read image: ${file.name}`);
                this._showStatus(window.i18n?.t('emailCompose.imageReadFailed') || 'Failed to read image，converted to attachment', 'error');
                this._handleDroppedFiles([file]);
            };
            reader.readAsDataURL(file);
        }

        this._showStatus((window.i18n?.t('emailCompose.imagesInserted') || 'Inserted {count} image(s) into email body').replace('{count}', files.length), 'success');
    }

    /**
     * Handle dropped files
     */
    _handleDroppedFiles(files) {
        for (const file of files) {
            if (this._attachments.length >= 10) {
                this._showStatus(window.i18n?.t('emailCompose.maxAttachments') || 'can add at most10attachment(s)', 'error');
                break;
            }

            const maxSize = 25 * 1024 * 1024;
            if (file.size > maxSize) {
                this._showStatus((window.i18n?.t('emailCompose.fileSizeLimit') || 'file "{name}" exceed25MBlimit').replace('{name}', file.name), 'error');
                continue;
            }

            const fileId = `att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            // Get the file path (file.path is available in Electron)
            const filePath = file.path || window.electronAPI?.getFilePath?.(file) || null;

            const attachment = {
                id: fileId,
                filename: file.name,
                size: file.size,
                type: file.type,
                path: filePath
            };

            this._attachments.push(attachment);
            this._renderAttachmentItem(attachment);

            // If email subject is empty, auto-fill subject with attachment filename
            this._autoFillSubjectFromAttachment(file.name);

            console.log(`[MailinkEmailCompose] Dropped attachment added: ${file.name}, size: ${file.size}, path: ${filePath}`);
        }

        this._showStatus((window.i18n?.t('emailCompose.attachmentsAdded') || 'added {count} attachment(s)').replace('{count}', files.length), 'success');
    }

    async showCompose(originalEmail) {
        if (!originalEmail) {
            console.warn('[MailinkEmailCompose] No original email provided');
            return;
        }

        this._originalEmail = originalEmail;
        this._isVisible = true;
        this._isNewEmail = false;

        await this._initEditor();
        await this._initializeSuggestions();

        this._fillFormData();
        await this._showModal();

        setTimeout(() => {
            if (this._editor && this._editorInitialized) {
                this._editor.focus();
            }
        }, 200);
    }

    async showNewEmailCompose(defaultTo = '', defaultSubject = '') {
        this._isVisible = true;
        this._isNewEmail = true;
        this._originalEmail = null;

        await this._initEditor();
        await this._initializeSuggestions();

        this._fillNewEmailFormData(defaultTo, defaultSubject);
        await this._showModal();

        setTimeout(() => {
            if (this._editor && this._editorInitialized) {
                this._editor.focus();
            }
        }, 200);
    }

    _fillFormData() {
        const email = this._originalEmail;

        // Clear recipient chips
        this._toChips = [];

        // If there is an original sender, add to the recipient chips
        if (email.from) {
            this._toChips.push(email.from);
        }

        // Render recipient chips
        this._renderToChips();

        // Set sender as current logged-in account
        this._setFromFieldFromConfig();

        const subjectField = this.querySelector('#composeSubjectField');
        if (subjectField) {
            const originalSubject = email.subject || '';
            subjectField.value = originalSubject.toLowerCase().startsWith('re:')
                ? originalSubject
                : `Re: ${originalSubject}`;
        }

        const originalFrom = this.querySelector('#originalFrom');
        const originalDate = this.querySelector('#originalDate');
        const originalContent = this.querySelector('#originalContent');
        const originalSection = this.querySelector('#originalEmailSection');

        if (originalFrom) originalFrom.textContent = email.from || (window.i18n?.t('common.unknownSender') || 'Unknown sender');
        if (originalDate) originalDate.textContent = this._formatDate(email.date);
        if (originalContent) {
            originalContent.innerHTML = this._formatOriginalContent(email);
        }
        if (originalSection) {
            originalSection.style.display = 'block';
        }

        if (this._editor && this._editorInitialized) {
            this._editor.setContent('<p><br></p>');
        }
    }

    _fillNewEmailFormData(defaultTo = '', defaultSubject = '') {
        // Clear recipient chips
        this._toChips = [];

        // If there is a default recipient, add it to the chips
        if (defaultTo && defaultTo.trim()) {
            const emails = defaultTo.split(/[,;]/);
            emails.forEach(email => {
                const trimmed = email.trim();
                if (trimmed && this._isEmail(trimmed) && !this._toChips.includes(trimmed)) {
                    this._toChips.push(trimmed);
                }
            });
        }

        // Render recipient chips
        this._renderToChips();

        // Set sender as current logged-in account
        this._setFromFieldFromConfig();

        const subjectField = this.querySelector('#composeSubjectField');
        if (subjectField) {
            subjectField.value = defaultSubject;
        }

        const originalSection = this.querySelector('#originalEmailSection');
        if (originalSection) {
            originalSection.style.display = 'none';
        }

        if (this._editor && this._editorInitialized) {
            this._editor.setContent('<p><br></p>');
        }

        // Focus on the recipient input field
        const toChipsInput = this.querySelector('#toChipsInput');
        if (toChipsInput) {
            setTimeout(() => toChipsInput.focus(), 100);
        }
    }

    _formatOriginalContent(email) {
        if (email.html) return this._sanitizeHtml(email.html);
        if (email.text) return `<pre>${this._escapeHtml(email.text)}</pre>`;
        return '<p style="color: #8c8c8c;">' + (window.i18n?.t('emailCompose.noContent') || '（no body content）') + '</p>';
    }

    _sanitizeHtml(html) {
        if (!html) return '';
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        const dangerousTags = ['script', 'style', 'iframe', 'object', 'embed'];
        dangerousTags.forEach(tag => {
            const elements = doc.getElementsByTagName(tag);
            for (let i = elements.length - 1; i >= 0; i--) {
                elements[i].remove();
            }
        });

        return doc.body.innerHTML;
    }

    _escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    _formatDate(date) {
        if (!date) return '';
        const d = new Date(date);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleString(window.i18n?.getLocale() || 'zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
    }

    async _sendEmail() {
        if (this._isSending || !this._editor || !this._editorInitialized) return;

        // Get recipients from chips
        const to = this._toChips.join(', ').trim();
        
        const subjectField = this.querySelector('#composeSubjectField');
        const subject = subjectField ? subjectField.value.trim() : '';

        const htmlContent = this._editor.getContent();
        const textContent = this._editor.getContent({ format: 'text' });

        if (!to) {
            this._showStatus(window.i18n?.t('emailCompose.recipientRequired') || 'Recipient cannot be empty', 'error');
            return;
        }

        if (!subject) {
            this._showStatus(window.i18n?.t('emailCompose.subjectRequired') || 'Subject cannot be empty', 'error');
            return;
        }

        const config = window.getSelectedConfig ? window.getSelectedConfig() : null;
        if (!config) {
            this._showStatus(window.i18n?.t('emailCompose.pleaseSelectConfig') || 'Please select and log in to email configuration first', 'error');
            return;
        }

        this._isSending = true;
        this._setSendingState(true);

        try {
            const fullBody = this._buildEmailBody(textContent);
            const fullHtml = this._buildEmailHtml(htmlContent);

            if (window.electronAPI && window.electronAPI.sendemail) {
                const attachments = this._attachments.map(att => ({
                    filename: att.filename,
                    path: att.path
                }));

                const result = await window.electronAPI.sendemail(config, {
                    to: to,
                    subject: subject,
                    text: fullBody,
                    html: fullHtml,
                    attachments: attachments
                });

                this._showStatus(window.i18n?.t('emailCompose.emailSentSuccess') || 'email sent successfully', 'success');

                this.dispatchEvent(new CustomEvent('emailSent', {
                    detail: { success: true, to, subject, isNewEmail: this._isNewEmail },
                    bubbles: true,
                    composed: true
                }));

                setTimeout(() => this.close(), 1500);
            } else {
                throw new Error(window.i18n?.t('emailCompose.sendApiUnavailable') || 'Send emailAPIunavailable');
            }
        } catch (error) {
            console.error('[MailinkEmailCompose] Failed to send email:', error);
            this._showStatus(`${window.i18n?.t('emailCompose.emailSendFailed') || 'failed to send'}: ${error.message}`, 'error');

            this.dispatchEvent(new CustomEvent('emailSent', {
                detail: { success: false, error: error.message },
                bubbles: true,
                composed: true
            }));
        } finally {
            this._isSending = false;
            this._setSendingState(false);
        }
    }

    _buildEmailBody(body) {
        if (this._isNewEmail || !this._originalEmail) {
            return body;
        }

        const original = this._originalEmail;
        let fullBody = body + '\n\n';
        fullBody += (window.i18n?.t('emailCompose.originalEmailHeader') || '--- original email ---') + '\n';
        fullBody += `${window.i18n?.t('emailCompose.originalFrom') || 'sender：'}${original.from || (window.i18n?.t('common.unknownSender') || 'unknown')}\n`;
        fullBody += `${window.i18n?.t('emailCompose.originalTime') || 'time：'}${this._formatDate(original.date)}\n`;
        fullBody += `${window.i18n?.t('emailCompose.originalSubject') || 'subject：'}${original.subject || (window.i18n?.t('common.noSubject') || '(no subject)')}\n\n`;

        if (original.text) {
            fullBody += original.text;
        } else if (original.html) {
            fullBody += original.html.replace(/<[^>]+>/g, '');
        }

        return fullBody;
    }

    _buildEmailHtml(body) {
        if (this._isNewEmail || !this._originalEmail) {
            return `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6;">${body}</div>`;
        }

        const original = this._originalEmail;

        let html = `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6;">`;
        html += `<div>${body}</div>`;
        html += `<div style="margin-top: 20px; padding-top: 10px; border-top: 1px solid #e0e0e0; color: #666; font-size: 12px;">`;
        html += `<div>${window.i18n?.t('emailCompose.originalEmailHeader') || '--- original email ---'}</div>`;
        html += `<div><strong>${window.i18n?.t('emailCompose.originalFrom') || 'sender：'}</strong> ${this._escapeHtml(original.from || (window.i18n?.t('common.unknownSender') || 'unknown'))}</div>`;
        html += `<div><strong>${window.i18n?.t('emailCompose.originalTime') || 'time：'}</strong> ${this._formatDate(original.date)}</div>`;
        html += `<div><strong>${window.i18n?.t('emailCompose.originalSubject') || 'subject：'}</strong> ${this._escapeHtml(original.subject || (window.i18n?.t('common.noSubject') || '(no subject)'))}</div>`;
        html += `</div>`;

        if (original.html) {
            html += `<div style="margin-top: 10px; padding: 10px; background: #f5f5f5; border-left: 3px solid #1890ff;">${original.html}</div>`;
        } else if (original.text) {
            html += `<div style="margin-top: 10px; padding: 10px; background: #f5f5f5; border-left: 3px solid #1890ff; white-space: pre-wrap;">${this._escapeHtml(original.text)}</div>`;
        }

        html += `</div>`;
        return html;
    }

    _setSendingState(isSending) {
        const sendBtn = this.querySelector('#sendComposeBtn');
        if (sendBtn) {
            sendBtn.disabled = isSending;
            sendBtn.innerHTML = isSending
                ? '<span>' + (window.i18n?.t('emailCompose.sending') || 'sending...') + '</span>'
                : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="22" y1="2" x2="11" y2="13"></line>
                    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                   </svg><span>${window.i18n?.t('common.send') || 'send'}</span>`;
        }
    }

    _handleFileSelect(event) {
        const files = event.target.files;
        if (!files || files.length === 0) return;

        for (const file of files) {
            if (this._attachments.length >= 10) {
                this._showStatus(window.i18n?.t('emailCompose.maxAttachments') || 'can add at most10attachment(s)', 'error');
                break;
            }

            const maxSize = 25 * 1024 * 1024;
            if (file.size > maxSize) {
                this._showStatus((window.i18n?.t('emailCompose.fileSizeLimit') || 'file "{name}" exceed25MBlimit').replace('{name}', file.name), 'error');
                continue;
            }

            const fileId = `att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            const filePath = window.electronAPI.getFilePath(file);

            const attachment = {
                id: fileId,
                filename: file.name,
                size: file.size,
                type: file.type,
                path: filePath
            };

            this._attachments.push(attachment);
            this._renderAttachmentItem(attachment);

            // If email subject is empty, auto-fill subject with attachment filename
            this._autoFillSubjectFromAttachment(file.name);

            console.log(`[MailinkEmailCompose] Attachment added: ${file.name}, size: ${file.size}, path: ${filePath}`);
        }

        event.target.value = '';
    }

    _autoFillSubjectFromAttachment(filename) {
        const subjectField = this.querySelector('#composeSubjectField');
        if (!subjectField) return;

        // If the subject is empty, use the filename (without the extension) as the subject
        const currentSubject = subjectField.value.trim();
        if (!currentSubject) {
            // Remove the extension, only use the file name part
            const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
            subjectField.value = nameWithoutExt;
            console.log(`[MailinkEmailCompose] Auto-filled subject from attachment: ${nameWithoutExt}`);
        }
    }

    _renderAttachmentItem(attachment) {
        const attachmentsList = this.querySelector('#attachmentsList');
        if (!attachmentsList) return;

        const itemEl = document.createElement('div');
        itemEl.className = 'email-compose-attachment-item';
        itemEl.dataset.id = attachment.id;

        const iconEl = document.createElement('div');
        iconEl.className = 'email-compose-attachment-icon';
        iconEl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
        </svg>`;

        const infoEl = document.createElement('div');
        infoEl.className = 'email-compose-attachment-info';
        infoEl.innerHTML = `
            <div class="email-compose-attachment-name" title="${attachment.filename}">${attachment.filename}</div>
            <div class="email-compose-attachment-size">${this._formatFileSize(attachment.size)}</div>
        `;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'email-compose-attachment-remove';
        removeBtn.type = 'button';
        removeBtn.title = window.i18n?.t('emailCompose.removeAttachment') || 'Remove attachment';
        removeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>`;
        removeBtn.addEventListener('click', () => this._removeAttachment(attachment.id));

        itemEl.appendChild(iconEl);
        itemEl.appendChild(infoEl);
        itemEl.appendChild(removeBtn);
        attachmentsList.appendChild(itemEl);
    }

    _removeAttachment(attachmentId) {
        const index = this._attachments.findIndex(a => a.id === attachmentId);
        if (index !== -1) {
            this._attachments.splice(index, 1);
            const itemEl = this.querySelector(`.email-compose-attachment-item[data-id="${attachmentId}"]`);
            if (itemEl) {
                itemEl.remove();
            }
            console.log(`[MailinkEmailCompose] Attachment removed: ${attachmentId}`);
        }
    }

    _formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    _clearAttachments() {
        this._attachments = [];
        const attachmentsList = this.querySelector('#attachmentsList');
        if (attachmentsList) {
            attachmentsList.innerHTML = '';
        }
    }

    _showStatus(message, type) {
        const existingStatus = this.querySelector('.email-compose-status-message');
        if (existingStatus) existingStatus.remove();

        const statusEl = document.createElement('div');
        statusEl.className = `email-compose-status-message email-compose-status-${type}`;
        statusEl.textContent = message;
        this.appendChild(statusEl);

        setTimeout(() => {
            if (statusEl.parentNode) statusEl.remove();
        }, 3000);
    }

    async _showModal() {
        const overlay = this.querySelector('#composeOverlay');
        if (overlay) {
            // Clean up residual styles
            overlay.style.opacity = '';
            overlay.style.pointerEvents = '';
            const modal = overlay.querySelector('#composeModal');
            if (modal) {
                modal.style.opacity = '';
                modal.style.transform = '';
                modal.style.transformOrigin = '';
            }
            overlay.classList.add('show');
            // Play open animation
            await playOpenAnimation(overlay, '#composeModal');
        }
    }

    _hideModal() {
        const overlay = this.querySelector('#composeOverlay');
        if (overlay) overlay.classList.remove('show');
    }

    async close() {
        // Play shared close animation (overlay fades out + modal shrinks to top-left)
        const overlay = this.querySelector('#composeOverlay');
        if (overlay) {
            await playCloseAnimation(overlay, '#composeModal');
        }

        // Clean up after animation ends
        this._isVisible = false;
        this._hideModal();
        this._originalEmail = null;

        // Clear debounce timer
        if (this._toInputDebounceTimer) {
            clearTimeout(this._toInputDebounceTimer);
            this._toInputDebounceTimer = null;
        }

        // Clear recipient chips
        this._toChips = [];
        this._toSuggestions = [];
        this._currentToSuggestionIndex = -1;
        this._renderToChips();

        // Clear the sender field
        const fromField = this.querySelector('#fromFieldReadonly');
        if (fromField) {
            fromField.value = '';
        }

        const subjectField = this.querySelector('#composeSubjectField');
        if (subjectField) subjectField.value = '';
        if (this._editor && this._editorInitialized) {
            this._editor.setContent('<p><br></p>');
        }

        this._clearAttachments();

        this.dispatchEvent(new CustomEvent('composeClosed', {
            bubbles: true,
            composed: true
        }));
    }

    get isVisible() {
        return this._isVisible;
    }

    _setFromFieldFromConfig() {
        const fromField = this.querySelector('#fromFieldReadonly');
        if (!fromField) return;

        try {
            // Prefer to get from sessionStorage
            let email = sessionStorage.getItem('mymail');
            
            // Secondly, get it from the global configuration
            if (!email && window.selectedConfig?.username) {
                email = window.selectedConfig.username;
            }
            
            // Try to get from getSelectedConfig again
            if (!email && typeof window.getSelectedConfig === 'function') {
                const config = window.getSelectedConfig();
                if (config && config.username) {
                    email = config.username;
                }
            }
            
            // Finally, get it from currentMyEmail
            if (!email && window.currentMyEmail) {
                email = window.currentMyEmail;
            }

            fromField.value = email || (window.i18n?.t('emailCompose.fromPlaceholder') || 'no account selected');
        } catch (error) {
            console.error('[MailinkEmailCompose] Error setting from field:', error);
            fromField.value = window.i18n?.t('emailCompose.fromPlaceholder') || 'no account selected';
        }
    }

    // ============ Methods related to Chips ============

    _isEmail(value) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(value.trim());
    }

    // ============ Recipient Chips Method ============

    _addToChip(value) {
        const email = value.trim();
        console.log('[MailinkEmailCompose] _addToChip called with:', { value, email });
        
        if (!email || !this._isEmail(email)) {
            console.warn('[MailinkEmailCompose] Invalid email:', { email, isEmail: this._isEmail(email) });
            return false;
        }
        
        // Check for duplicates
        if (this._toChips.some(chip => chip.toLowerCase() === email.toLowerCase())) {
            console.warn('[MailinkEmailCompose] Duplicate email:', email);
            return false;
        }

        console.log('[MailinkEmailCompose] Adding chip:', email);
        this._toChips.push(email);
        this._renderToChips();
        console.log('[MailinkEmailCompose] Chip added, total chips:', this._toChips.length);
        return true;
    }

    _removeToChip(index) {
        if (index >= 0 && index < this._toChips.length) {
            this._toChips.splice(index, 1);
            this._renderToChips();
        }
    }

    _renderToChips() {
        const field = this.querySelector('#toChipsField');
        const input = this.querySelector('#toChipsInput');

        if (!field || !input) return;

        // Remove all existing chip elements
        const existingChips = field.querySelectorAll('.email-compose-chip');
        existingChips.forEach(chip => chip.remove());

        // Add new chip elements
        this._toChips.forEach((email, idx) => {
            const chip = document.createElement('span');
            chip.className = 'email-compose-chip';
            
            const text = document.createElement('span');
            text.textContent = email;
            
            const removeBtn = document.createElement('button');
            removeBtn.className = 'email-compose-chip-remove';
            removeBtn.type = 'button';
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._removeToChip(idx);
            });

            chip.appendChild(text);
            chip.appendChild(removeBtn);
            field.insertBefore(chip, input);
        });
    }

    _handleToChipsKeydown(e) {
        const input = this.querySelector('#toChipsInput');
        if (!input) return;

        // Handle Enter key: prioritize suggested items
        if (e.key === 'Enter') {
            e.preventDefault();
            
            // If there is a highlighted suggestion, select it
            if (this._currentToSuggestionIndex >= 0 && 
                this._currentToSuggestionIndex < this._toSuggestions.length) {
                const contact = this._toSuggestions[this._currentToSuggestionIndex];
                if (contact && contact.username) {
                    console.log('[MailinkEmailCompose] Selecting suggestion via Enter:', contact.username);
                    this._addToChip(contact.username);
                    input.value = '';
                    this._hideToSuggestions();
                    this._currentToSuggestionIndex = -1;
                    return;
                }
            }
            
            // Otherwise, add the text from the input box
            const value = input.value.trim();
            if (value) {
                if (this._addToChip(value)) {
                    input.value = '';
                    this._hideToSuggestions();
                } else {
                    this._showStatus(window.i18n?.t('emailCompose.invalidEmailOrAdded') || 'invalid or already added email address', 'error');
                }
            }
            return;
        }

        // Tab and comma: add the currently entered text
        if (['Tab', ','].includes(e.key)) {
            e.preventDefault();
            const value = input.value.trim();
            
            if (value) {
                if (this._addToChip(value)) {
                    input.value = '';
                    this._hideToSuggestions();
                } else {
                    this._showStatus(window.i18n?.t('emailCompose.invalidEmailOrAdded') || 'invalid or already added email address', 'error');
                }
            }
            return;
        }

        // Backspace: delete last chip when input is empty
        if (e.key === 'Backspace' && !input.value && this._toChips.length > 0) {
            e.preventDefault();
            this._removeToChip(this._toChips.length - 1);
            return;
        }

        // ArrowUp/ArrowDown: navigate suggestions
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            this._currentToSuggestionIndex--;
            if (this._currentToSuggestionIndex < 0) {
                this._currentToSuggestionIndex = this._toSuggestions.length - 1;
            }
            this._updateToSuggestionHighlight();
            return;
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this._currentToSuggestionIndex++;
            if (this._currentToSuggestionIndex >= this._toSuggestions.length) {
                this._currentToSuggestionIndex = 0;
            }
            this._updateToSuggestionHighlight();
            return;
        }

        // Reset suggestion index in other cases
        this._currentToSuggestionIndex = -1;
    }

    _handleToChipsInput(e) {
        const input = e.target;
        const value = input.value.trim();

        if (!value) {
            this._hideToSuggestions();
            return;
        }

        // Generate suggestions
        this._toSuggestions = [];
        if (this._isEmail(value) && !this._toChips.find(chip => chip.toLowerCase() === value.toLowerCase())) {
            this._toSuggestions.push(value);
        }

        this._showToSuggestions();
    }

    _handleToChipsPaste(e) {
        e.preventDefault();
        const text = e.clipboardData.getData('text');
        
        // Split email address
        const emails = text.split(/[,;\s]+/).filter(e => e.trim());
        
        let addedCount = 0;
        emails.forEach(email => {
            if (this._addToChip(email)) {
                addedCount++;
            }
        });

        const input = this.querySelector('#toChipsInput');
        if (input) {
            input.value = '';
            this._handleToChipsInput({ target: input });
        }

        if (addedCount > 0) {
            this._showStatus((window.i18n?.t('emailCompose.recipientsAdded') || 'added {count} recipient(s)').replace('{count}', addedCount), 'success');
        }
    }

    _handleToChipsBlur() {
        const input = this.querySelector('#toChipsInput');
        if (!input) return;

        setTimeout(() => {
            const value = input.value.trim();
            
            // If input has content, try to add as chip
            if (value) {
                if (this._addToChip(value)) {
                    input.value = '';
                }
            }
            
            this._hideToSuggestions();
        }, 100);
    }

    _showToSuggestions() {
        const suggestions = this.querySelector('#toChipsSuggestions');
        if (!suggestions) return;

        suggestions.innerHTML = '';

        this._toSuggestions.forEach((email, idx) => {
            const item = document.createElement('div');
            item.className = 'email-compose-suggestion-item';
            if (idx === this._currentToSuggestionIndex) {
                item.classList.add('active');
            }
            item.textContent = email;
            item.addEventListener('click', () => {
                this._addToChip(email);
                const input = this.querySelector('#toChipsInput');
                if (input) {
                    input.value = '';
                    input.focus();
                }
                this._hideToSuggestions();
            });
            suggestions.appendChild(item);
        });

        if (this._toSuggestions.length > 0) {
            suggestions.removeAttribute('hidden');
        } else {
            suggestions.setAttribute('hidden', '');
        }
    }

    _hideToSuggestions() {
        const suggestions = this.querySelector('#toChipsSuggestions');
        if (suggestions) {
            suggestions.setAttribute('hidden', '');
        }
        this._toSuggestions = [];
        this._currentToSuggestionIndex = -1;
    }

    _updateToSuggestionHighlight() {
        const items = this.querySelector('#toChipsSuggestions')?.querySelectorAll('.email-compose-suggestion-item');
        if (!items) return;

        items.forEach((item, idx) => {
            if (idx === this._currentToSuggestionIndex) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });
    }

    // ============ Associative Search Method ============

    /**
     * Debounce handling: input box input event
     * Execute the actual search and suggestion display after 300ms
     */
    _handleToChipsInputDebounce(e) {
        const input = e.target;
        const value = input.value.trim();

        // Clear the previous debounce timer
        if (this._toInputDebounceTimer) {
            clearTimeout(this._toInputDebounceTimer);
        }

        // If the input is empty, hide the suggestions directly
        if (!value) {
            this._hideToSuggestions();
            return;
        }

        // Save the input box reference and perform the search after 300ms
        // Note: The event object e cannot be passed directly, as it will be recycled by the browser
        this._toInputDebounceTimer = setTimeout(() => {
            this._handleToChipsInputWithSearch();
        }, 300);
    }

    /**
     * Handle input box input events: get contact suggestions
     * Note: does not receive event parameters, directly queries the DOM to get the current input box state
     */
    async _handleToChipsInputWithSearch() {
        const input = this.querySelector('#toChipsInput');
        if (!input) {
            console.warn('[MailinkEmailCompose] toChipsInput not found');
            return;
        }

        const searchText = input.value.trim();

        if (!searchText) {
            this._hideToSuggestions();
            return;
        }

        // If the contacts have not been loaded yet, load them first
        if (!this._contactsLoaded) {
            await this._loadAllContacts();
        }

        // Filter and sort contacts
        const suggestions = this._filterAndSortContacts(searchText);

        // Update suggestion list
        this._toSuggestions = suggestions;
        this._currentToSuggestionIndex = -1;
        this._showToSuggestionsEnhanced();
    }

    /**
     * Load all contacts (cached at once)
     */
    async _loadAllContacts() {
        try {
            if (!window.electronAPI || !window.electronAPI.getContacts) {
                console.warn('[MailinkEmailCompose] getContacts API not available');
                this._contactsLoaded = true;
                return;
            }

            // Get the currently logged-in user
            const currentConfig = window.getSelectedConfig ? window.getSelectedConfig() : null;
            if (!currentConfig || !currentConfig.username) {
                console.warn('[MailinkEmailCompose] No current config found');
                this._contactsLoaded = true;
                return;
            }

            this._currentLoginUsername = currentConfig.username;

            // Call IPC to get all contacts
            const contacts = await window.electronAPI.getContacts(currentConfig.username);
            this._allContacts = Array.isArray(contacts) ? contacts : [];

            console.log(`[MailinkEmailCompose] Loaded ${this._allContacts.length} contacts`);
            this._contactsLoaded = true;
        } catch (error) {
            console.error('[MailinkEmailCompose] Error loading contacts:', error);
            this._allContacts = [];
            this._contactsLoaded = true;
        }
    }

    /**
     * Filter and sort contacts: supports email and name search
     * @param {string} searchText - search text
     * @returns {Array} sorted contact list
     */
    _filterAndSortContacts(searchText) {
        if (!searchText || !this._allContacts.length) {
            return [];
        }

        const searchLower = searchText.toLowerCase();

        // Category score calculation
        const scored = this._allContacts
            .filter(contact => {
                // Check both the email (username) and the name (nickname) at the same time, excluding those already selected
                const email = (contact.username || '').toLowerCase();
                const name = (contact.nickname || '').toLowerCase();
                
                // Exclude already added
                if (this._toChips.find(chip => chip.toLowerCase() === email)) {
                    return false;
                }

                return email.includes(searchLower) || name.includes(searchLower);
            })
            .map(contact => {
                const email = (contact.username || '').toLowerCase();
                const name = (contact.nickname || '').toLowerCase();
                let score = 0;

                // Exact prefix match: highest priority
                if (email.startsWith(searchLower)) {
                    score += 100;
                }
                if (name.startsWith(searchLower)) {
                    score += 80;
                }

                // Email contains match
                if (email.includes(searchLower) && email.indexOf(searchLower) < 5) {
                    score += 50;
                }
                if (email.includes(searchLower)) {
                    score += 20;
                }

                // Name contains match
                if (name.includes(searchLower)) {
                    score += 10;
                }

                return { contact, score };
            });

        // Sort by score, then limit the quantity
        return scored
            .sort((a, b) => b.score - a.score)
            .slice(0, 10)
            .map(item => item.contact);
    }

    /**
     * Show contact suggestions (Enhanced version: shows email and name)
     */
    _showToSuggestionsEnhanced() {
        const suggestions = this.querySelector('#toChipsSuggestions');
        if (!suggestions) return;

        suggestions.innerHTML = '';

        this._toSuggestions.forEach((contact, idx) => {
            const item = document.createElement('div');
            item.className = 'email-compose-suggestion-item';
            item.setAttribute('data-email', contact.username || '');
            
            if (idx === this._currentToSuggestionIndex) {
                item.classList.add('active');
            }

            // Display email and name
            const email = contact.username || '';
            const name = contact.nickname || '';
            
            let displayText = email;
            if (name && name !== email) {
                displayText += `  - ${name}`;
            }

            item.textContent = displayText;
            item.style.cursor = 'pointer';
            item.title = email; // Show the full email when hovering

            suggestions.appendChild(item);
        });

        if (this._toSuggestions.length > 0) {
            suggestions.removeAttribute('hidden');
        } else {
            suggestions.setAttribute('hidden', '');
        }
    }

    /**
     * Listen for focus events: load contacts when opened
     */
    async _initializeSuggestions() {
        if (!this._contactsLoaded) {
            await this._loadAllContacts();
        }
    }

    // ============================================

    // ============ Sender Chips Method ============

    _addFromChip(value) {
        const email = value.trim();
        if (!email || !this._isEmail(email)) return false;
        
        // Check for duplicates
        if (this._fromChips.some(chip => chip.toLowerCase() === email.toLowerCase())) {
            return false;
        }

        this._fromChips.push(email);
        this._renderFromChips();
        return true;
    }

    _removeFromChip(index) {
        if (index >= 0 && index < this._fromChips.length) {
            this._fromChips.splice(index, 1);
            this._renderFromChips();
        }
    }

    _renderFromChips() {
        const field = this.querySelector('#fromChipsField');
        const input = this.querySelector('#fromChipsInput');

        if (!field || !input) return;

        // Remove all existing chip elements
        const existingChips = field.querySelectorAll('.email-compose-chip');
        existingChips.forEach(chip => chip.remove());

        // Add new chip elements
        this._fromChips.forEach((email, idx) => {
            const chip = document.createElement('span');
            chip.className = 'email-compose-chip';
            
            const text = document.createElement('span');
            text.textContent = email;
            
            const removeBtn = document.createElement('button');
            removeBtn.className = 'email-compose-chip-remove';
            removeBtn.type = 'button';
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._removeFromChip(idx);
            });

            chip.appendChild(text);
            chip.appendChild(removeBtn);
            field.insertBefore(chip, input);
        });
    }

    _handleFromChipsKeydown(e) {
        const input = this.querySelector('#fromChipsInput');
        if (!input) return;

        // Handle carriage return, Tab, comma
        if (['Enter', 'Tab', ','].includes(e.key)) {
            e.preventDefault();
            const value = input.value.trim();
            
            if (value) {
                if (this._addFromChip(value)) {
                    input.value = '';
                    this._hideFromSuggestions();
                } else {
                    this._showStatus(window.i18n?.t('emailCompose.invalidEmailOrAdded') || 'invalid or already added email address', 'error');
                }
            }
            return;
        }

        // Backspace: delete last chip when input is empty
        if (e.key === 'Backspace' && !input.value && this._fromChips.length > 0) {
            e.preventDefault();
            this._removeFromChip(this._fromChips.length - 1);
            return;
        }

        // ArrowUp/ArrowDown: navigate suggestions
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            this._currentFromSuggestionIndex--;
            if (this._currentFromSuggestionIndex < 0) {
                this._currentFromSuggestionIndex = this._fromSuggestions.length - 1;
            }
            this._updateFromSuggestionHighlight();
            return;
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this._currentFromSuggestionIndex++;
            if (this._currentFromSuggestionIndex >= this._fromSuggestions.length) {
                this._currentFromSuggestionIndex = 0;
            }
            this._updateFromSuggestionHighlight();
            return;
        }

        this._currentFromSuggestionIndex = -1;
    }

    _handleFromChipsInput(e) {
        const input = e.target;
        const value = input.value.trim();

        if (!value) {
            this._hideFromSuggestions();
            return;
        }

        // Generate suggestions
        this._fromSuggestions = [];
        if (this._isEmail(value) && !this._fromChips.find(chip => chip.toLowerCase() === value.toLowerCase())) {
            this._fromSuggestions.push(value);
        }

        this._showFromSuggestions();
    }

    _handleFromChipsPaste(e) {
        e.preventDefault();
        const text = e.clipboardData.getData('text');
        
        // Split email address
        const emails = text.split(/[,;\s]+/).filter(e => e.trim());
        
        let addedCount = 0;
        emails.forEach(email => {
            if (this._addFromChip(email)) {
                addedCount++;
            }
        });

        const input = this.querySelector('#fromChipsInput');
        if (input) {
            input.value = '';
            this._handleFromChipsInput({ target: input });
        }

        if (addedCount > 0) {
            this._showStatus((window.i18n?.t('emailCompose.sendersAdded') || 'added {count} sender(s)').replace('{count}', addedCount), 'success');
        }
    }

    _handleFromChipsBlur() {
        const input = this.querySelector('#fromChipsInput');
        if (!input) return;

        setTimeout(() => {
            const value = input.value.trim();
            
            // If input has content, try to add as chip
            if (value) {
                if (this._addFromChip(value)) {
                    input.value = '';
                }
            }
            
            this._hideFromSuggestions();
        }, 100);
    }

    _showFromSuggestions() {
        const suggestions = this.querySelector('#fromChipsSuggestions');
        if (!suggestions) return;

        suggestions.innerHTML = '';

        this._fromSuggestions.forEach((email, idx) => {
            const item = document.createElement('div');
            item.className = 'email-compose-suggestion-item';
            if (idx === this._currentFromSuggestionIndex) {
                item.classList.add('active');
            }
            item.textContent = email;
            item.addEventListener('click', () => {
                this._addFromChip(email);
                const input = this.querySelector('#fromChipsInput');
                if (input) {
                    input.value = '';
                    input.focus();
                }
                this._hideFromSuggestions();
            });
            suggestions.appendChild(item);
        });

        if (this._fromSuggestions.length > 0) {
            suggestions.removeAttribute('hidden');
        } else {
            suggestions.setAttribute('hidden', '');
        }
    }

    _hideFromSuggestions() {
        const suggestions = this.querySelector('#fromChipsSuggestions');
        if (suggestions) {
            suggestions.setAttribute('hidden', '');
        }
        this._fromSuggestions = [];
        this._currentFromSuggestionIndex = -1;
    }

    _updateFromSuggestionHighlight() {
        const items = this.querySelector('#fromChipsSuggestions')?.querySelectorAll('.email-compose-suggestion-item');
        if (!items) return;

        items.forEach((item, idx) => {
            if (idx === this._currentFromSuggestionIndex) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });
    }

    // ============================================

    disconnectedCallback() {
        if (window.i18n?.unregisterRoot) window.i18n.unregisterRoot(this);
        if (this._handleLangChanged) {
            window.removeEventListener('lang-changed', this._handleLangChanged);
        }
        if (this._handleEscKey) {
            document.removeEventListener('keydown', this._handleEscKey);
        }
        if (this._editor && this._editorInitialized) {
            this._editor.remove();
            this._editor = null;
            this._editorInitialized = false;
        }
    }

    /**
     * Enforce position restrictions
     * Check and automatically adapt restrictions when clicked, ensuring the top of the component does not go beyond the title bar
     * The write email component is a modal popup, usually displayed centered; this method is used to ensure the position is correct
     */
    _enforcePositionLimit() {
        const overlay = this.querySelector('#composeOverlay');
        const modal = this.querySelector('#composeModal');
        if (!overlay || !modal) return;

        const titlebarHeight = 32;
        const modalRect = modal.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();

        // Check if top exceeds title bar
        if (modalRect.top < titlebarHeight) {
            const currentPadding = parseInt(window.getComputedStyle(overlay).paddingTop) || 20;
            const adjustment = titlebarHeight - modalRect.top + 10;
            overlay.style.paddingTop = `${currentPadding + adjustment}px`;
            console.log('[MailinkEmailCompose] Position enforced: padding adjusted');
        }

        // Check if left side exceeds boundary
        if (modalRect.left < 0) {
            const currentPadding = parseInt(window.getComputedStyle(overlay).paddingLeft) || 20;
            const adjustment = -modalRect.left + 10;
            overlay.style.paddingLeft = `${currentPadding + adjustment}px`;
            console.log('[MailinkEmailCompose] Position enforced: left padding adjusted');
        }

        // Check if right side exceeds boundary
        if (modalRect.right > window.innerWidth) {
            const currentPadding = parseInt(window.getComputedStyle(overlay).paddingRight) || 20;
            const adjustment = modalRect.right - window.innerWidth + 10;
            overlay.style.paddingRight = `${currentPadding + adjustment}px`;
            console.log('[MailinkEmailCompose] Position enforced: right padding adjusted');
        }

        // Check if bottom exceeds boundary
        if (modalRect.bottom > window.innerHeight) {
            const currentPadding = parseInt(window.getComputedStyle(overlay).paddingBottom) || 20;
            const adjustment = modalRect.bottom - window.innerHeight + 10;
            overlay.style.paddingBottom = `${currentPadding + adjustment}px`;
            console.log('[MailinkEmailCompose] Position enforced: bottom padding adjusted');
        }
    }
}

if (!customElements.get('mailink-email-compose')) {
    customElements.define('mailink-email-compose', MailinkEmailCompose);
}

export default MailinkEmailCompose;
