# Mailink

Author contact email: dingxinmike001@gmail.com

## Project Introduction

Mailink is a cross-platform email client based on **Electron 38**. It reads mailboxes via the IMAP protocol and displays email content. The project integrates core features such as **IMAP long-connection management, email parsing, and SQLite local storage**, providing an intuitive UI to help users quickly view emails from the last two days.

## Features

- **Multi-Account Support**: Configure multiple IMAP accounts in `config.json` and switch freely from the dropdown menu after startup.
- **IMAP Long-Connection Management**: Uses `imap-connection-manager` to maintain persistent connections, supports IDLE real-time push (implemented), and secure connection closing.
- **Email Parsing**: Based on `mailparser`, parses raw emails into structured data, displaying only the first 200 characters to improve rendering performance.
- **Local SQLite Storage**: Mailbox configurations and fetched email metadata are saved in `resources/sys/config.db`, enabling offline queries.
- **WebRTC Signaling**: Uses WebRTC to implement peer-to-peer email transmission signaling, improving real-time performance.
- **Cross-Platform**: Supports Windows, macOS, and Linux (runs after Electron packaging).

## Installation Steps

1. **Clone or Download the Project**
   ```bash
   git clone https://github.com/your-repo/mailink.git
   cd mailink
   ```
2. **Install Dependencies** (Ensure Node.js 14+ is installed)
   ```bash
   npm install
   ```
3. **Build (Optional)**
   - For development mode, run `npm start` directly.
   - For packaged release (Windows example)
     ```bash
     npm run build   # Based on the build script in package.json
     ```

## Configuration

Create or edit `config.json` in the project root directory. Example structure:

```json
{
  "imap": [
    {
      "id": "gmail",
      "name": "Gmail Account",
      "host": "imap.gmail.com",
      "port": 993,
      "username": "your_email@gmail.com",
      "password": "your_password",
      "tls": true
    },
    {
      "id": "outlook",
      "name": "Outlook Account",
      "host": "outlook.office365.com",
      "port": 993,
      "username": "your_email@outlook.com",
      "password": "your_password",
      "tls": true
    }
  ]
}
```

- **`id`**: Unique identifier for internal reference.
- **`tls`**: If `true`, uses SSL encrypted connection.
- **Password**: It is recommended to use an app-specific password or OAuth token, avoiding saving the master password in plain text.

## Usage

```bash
npm start
```

After startup, follow these steps:

1. Select the email account to log in to from the dropdown in the top-left corner.
2. Click the **"Login Email"** button; the program will establish an IMAP long connection and authenticate.
3. After successful login, the email viewer webcom on the right will load automatically.
4. In the email viewer, click **"Get Emails from Last 2 Days"**; the list will display the email subject, sender, and a preview of the first 200 characters.
5. To switch accounts, repeat steps 1-2; the old connection will be securely closed.

## Technology Stack

- **Electron 38** – Desktop application framework
- **node-imap** – IMAP protocol implementation
- **mailparser** – Email MIME parsing
- **sqlite3** – Local persistent storage
- **WebRTC** – Peer-to-peer signaling channel
- **JavaScript (ES6+)** – Business logic implementation

## Notes

- Ensure that **IMAP** is enabled for the mailbox; Gmail requires enabling in account settings and may require an **app-specific password**.
- Firewalls or proxies may block ports 993 (IMAP) / 587 (SMTP); please check your network environment.
- The project only displays the first 200 characters of the email body; full content can be extended by parsing with `mailparser` on the server side.
- When closing the application, `imap-connection-manager.disconnectAll()` is automatically called to ensure all IMAP long connections are securely released.

## Contribution Guide (Optional)

1. Fork this repository.
2. Create a `feature/your-feature` branch.
3. Submit code and pass the local `npm run lint` check.
4. Open a Pull Request with a clear description of the feature or bug fix.

## License

This project follows the **MIT License**. See the `LICENSE` file in the root directory for details.

---

If you have any questions or suggestions, feel free to raise them in GitHub Issues.
