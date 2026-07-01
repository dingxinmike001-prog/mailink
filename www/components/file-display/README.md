# File Display Component Library

## Introduction

This is a standalone Web Components library for displaying different types of files (normal files, images, videos) in chat records and email details.

## Directory Structure

```
file-display/
├── base/
│   └── file-display-base.js          # Base abstract class
├── components/
│   ├── normal-file-display/          # Normal file display component
│   │   └── normal-file-display.js
│   ├── image-file-display/           # Image file display component
│   │   └── image-file-display.js
│   └── video-file-display/           # Video file display component
│       └── video-file-display.js
├── utils/
│   └── file-type-resolver.js         # File type resolver utility
├── index.js                          # Unified entry
└── README.md                         # This file
```

## Supported File Types

| Component | Supported MIME types |
|------|---------------|
| normal-file-display | All types (fallback) |
| image-file-display | image/jpeg, image/png, image/gif, image/webp, image/bmp, image/svg+xml |
| video-file-display | video/mp4 |

## Usage

### 1. Register Components (only need to call once)

```javascript
import { registerAllComponents } from './components/file-display/index.js';

await registerAllComponents();
```

### 2. Create a File Display Component

```javascript
import { createFileDisplayComponent } from './components/file-display/index.js';

const offer = {
  id: '123',
  filename: 'photo.jpg',
  size: 2048000,
  mimeType: 'image/jpeg',
  storedFileName: 'photo.jpg'
};

const context = {
  logger: console,
  utils: { formatBytes: (bytes) => `${bytes} B` },
  myEmail: 'user@example.com',
  targetEmail: 'other@example.com'
};

const component = await createFileDisplayComponent(offer, false, context, '/path/to/file');
document.body.appendChild(component);
```

### 3. Listen for Component Events

```javascript
component.addEventListener('file-action', (e) => {
  const { transferId, action, filePath } = e.detail;
  console.log('File operation:', action, filePath);
});
```

## Component Events

The component dispatches a `file-action` event, whose detail includes:

- `transferId`: Transfer ID
- `action`: Action type ('accept', 'reject', 'open-folder', 'save-as')
- `filePath`: File path

## Utility Functions

```javascript
import {
  getFileType,           // Get file type category
  getComponentTagName,   // Get corresponding component tag name
  isImageFile,           // Check if file is an image
  isVideoFile,           // Check if file is a video
  isStreamingSupported,  // Check if streaming is supported
  getFileIcon            // Get file icon
} from './components/file-display/index.js';
```

## Integration Points

- **Chat component**: `www/webrtc/chat-component/modules/file-transfer/file-transfer-ui.js`
- **Email detail component**: `www/email-detail-component/index.js`

## Features

1. **Modular design**: Each file type has its own component, making it easy to maintain and extend
2. **Shadow DOM**: Styles are fully isolated and do not affect the outside
3. **Fallback**: Automatically falls back to traditional HTML when component creation fails
4. **Event communication**: Communicates with the outside via CustomEvent
5. **Automatic type detection**: Automatically selects the corresponding component based on the MIME type
