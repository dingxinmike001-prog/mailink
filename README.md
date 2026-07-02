# Mailink

Author contact email: dingxinmike001@gmail.com

## Project Introduction

Mailink is a cross-platform desktop email and instant messaging client built on **Electron 38**. It uses email protocols (IMAP / SMTP) as the underlying transport channel and combines **WebRTC P2P** to provide end-to-end encrypted instant messaging, audio/video calls, and file transfer. It also supports traditional email sending/receiving, parsing, and local storage. The project adopts a multi-process / multi-threaded architecture with an SQLite local database and a Worker thread pool to keep the UI smooth while handling complex network and compute tasks.

## Core Features

- **Multi-account IMAP login**: Add multiple email accounts in the settings and switch between them freely from the dropdown menu after startup.
- **IMAP long-connection management**: Maintains a connection pool with IDLE real-time push, heartbeat detection, auto-reconnect, and graceful disconnect.
- **Email sending/receiving**: Receives email via `imap` and sends email via `nodemailer`; `mailparser` parses raw emails into structured data.
- **WebRTC P2P communication**: Uses email as a decentralized signaling channel for P2P messaging, audio/video calls, and high-speed transfer of large files.
- **MP4 streaming transfer**: Supports playing large video files while they are still being transferred.
- **Local SQLite storage**: Uses `better-sqlite3` to store mailbox configurations, email metadata, message records, and file transfer progress, enabling offline queries.
- **Automatic contact backup**: Contacts are automatically backed up to the mailbox as a CSV attachment after changes, and restored from the mailbox on startup.
- **File security validation**: Multi-layer security policies on the frontend and backend block dangerous attachments such as executables and scripts.
- **Thumbnail generation**: Uses `sharp` to generate preview thumbnails for image attachments.
- **Multi-language support**: Built-in support for 13 languages (Traditional Chinese, Simplified Chinese, English, Japanese, German, French, Spanish, Portuguese, Russian, Italian, Dutch, Polish, Turkish), switchable at runtime without restart.
- **Cross-platform**: Built on Electron, packaged for Windows (NSIS / Portable), macOS, and Linux desktops.

## Technology Stack

| Domain | Technology | Version |
| --- | --- | --- |
| Desktop framework | Electron | ^38.0.0 |
| Database | better-sqlite3 | ^12.5.0 |
| IMAP protocol | imap | ^0.8.19 |
| SMTP protocol | nodemailer | ^7.0.10 |
| Email parsing | mailparser | ^3.6.5 |
| Media processing | mp4box | ^2.3.0 |
| Image processing | sharp | ^0.34.5 |
| Packaging tool | electron-builder | ^24.0.0 |
| Frontend components | Web Components (native) | - |

## Project Structure

```
mailink/
├── main.js                      # Electron main process entry
├── preload.js                   # Context Bridge / IPC security proxy
├── package.json                 # Project configuration and dependencies
├── resources/
│   ├── sys/
│   │   ├── config.db            # Global configuration database
│   │   ├── lang.json            # Language list
│   │   ├── lang/                # Translation files for each language
│   │   └── assets/              # Icons and other resources
│   └── users/
│       ├── log/                 # Global log directory
│       └── {username}/          # User data directory
│           ├── files/           # Sent and received files
│           ├── log/             # User log directory
│           └── {username}_emails.db  # User email database
├── service/                     # Main process backend services
│   ├── mail/                    # IMAP / SMTP / email processing
│   ├── sqlite/                  # SQLite database services
│   ├── http/                    # Local HTTP file service
│   ├── files/                   # File writing / copying / validation
│   ├── images/                  # Thumbnail generation
│   ├── security/                # File security validation
│   └── app-initializer.js       # Application directory initialization
├── shared/                      # Code shared between main and renderer
│   ├── worker/                  # Worker management framework
│   └── security/                # Security policy constants
├── src/                         # Renderer process source
│   └── www/                     # Frontend pages, Web Components, Workers
└── demo_screenshot/             # UI screenshots
```

For more detailed module descriptions, inter-process communication relationships, and database schema, please refer to [system-architecture-document.md](system-architecture-document.md).

## Installation and Running

### Requirements

- Node.js (recommended to be compatible with the Node version bundled with Electron 38)
- npm

### Install dependencies

```bash
npm install
```

The postinstall script automatically runs `electron-rebuild -f -w better-sqlite3` to rebuild native modules.

### Start the application

```bash
npm start
# or
npm run dev
```

### Packaging

```bash
# Generate directory only, no installer
npm run pack

# Default platform packaging
npm run dist

# Windows x64 packaging (NSIS + Portable)
npm run build:win
```

Packaging output is located in the `output/` directory.

## Email Account Configuration

You need to configure IMAP / SMTP accounts before first use. Configuration data is saved to the local SQLite database. You can also create a `config.json` in the project root as an example:

```json
{
  "imap": [
    {
      "id": "gmail",
      "name": "Gmail Account",
      "host": "imap.gmail.com",
      "port": 993,
      "username": "your_email@gmail.com",
      "password": "your_app_password",
      "tls": true
    }
  ],
  "smtp": [
    {
      "id": "gmail",
      "host": "smtp.gmail.com",
      "port": 587,
      "username": "your_email@gmail.com",
      "password": "your_app_password",
      "tls": true
    }
  ]
}
```

- `id`: Unique internal identifier for the account.
- `tls`: If `true`, uses an SSL/TLS encrypted connection.
- It is recommended to use an **app-specific password** or OAuth token instead of saving the master password in plain text.

## Usage

1. After startup, select the email account to log in to from the dropdown in the top-left corner.
2. Click **"Login Email"**; the program will establish an IMAP long connection and authenticate.
3. After successful login, the email viewer on the right will load automatically.
4. In the email viewer, click **"Get Emails from Last 2 Days"** to display the email list from the past two days.
5. Switch to the WebRTC chat component to send P2P messages, transfer files, or make audio/video calls with other Mailink users.
6. When switching accounts, the old connection will be safely closed and the login process will be repeated.

## Notes

- Make sure **IMAP / SMTP** is enabled for your mailbox; Gmail usually requires enabling it in account settings and using an **app-specific password**.
- Firewalls or proxies may block ports such as 993 (IMAP) and 587 (SMTP); please check your network environment.
- When the application closes, connection cleanup logic is automatically invoked to ensure all IMAP long connections are safely released.
- Large file transfers use streaming writes and support resumable transfer; progress and metadata are saved in the `transfer_metadata` table.

## Contributing

1. Fork this repository.
2. Create a feature branch: `git checkout -b feature/your-feature`.
3. Submit your code and make sure it passes local checks.
4. Open a Pull Request with a clear description of the feature or bug fix.

## License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file in the root directory for details.

---

If you have any questions or suggestions, feel free to open a GitHub Issue or contact the author at dingxinmike001@gmail.com.
