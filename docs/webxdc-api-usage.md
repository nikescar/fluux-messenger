# WebXDC API Usage Guide

## sendToChat()

Export files and text from your WebXDC app to the messenger chat.

### Example: Export text only
```javascript
await window.webxdc.sendToChat({
  text: "Hello from my WebXDC app!"
})
```

### Example: Export file (Blob)
```javascript
const blob = new Blob(["Hello, world!"], { type: "text/plain" })
await window.webxdc.sendToChat({
  file: {
    name: "greeting.txt",
    blob: blob
  },
  text: "Check out this file!"
})
```

### Example: Export file (base64)
```javascript
const base64 = btoa("Hello, world!")
await window.webxdc.sendToChat({
  file: {
    name: "greeting.txt",
    base64: base64
  }
})
```

## importFiles()

Import files from the messenger into your WebXDC app.

### Example: Import single image
```javascript
const files = await window.webxdc.importFiles({
  extensions: [".jpg", ".png"],
  mimeTypes: ["image/jpeg", "image/png"],
  multiple: false
})

if (files.length > 0) {
  const file = files[0]
  const url = URL.createObjectURL(file)
  document.querySelector("#preview").src = url
}
```

### Example: Import multiple files
```javascript
const files = await window.webxdc.importFiles({
  multiple: true
})

for (const file of files) {
  console.log(file.name, file.size, file.type)
}
```

## joinRealtimeChannel()

Real-time communication between WebXDC app instances.

### Example: Chat application
```javascript
const channel = window.webxdc.joinRealtimeChannel()

// Set up listener for incoming messages
channel.setListener((data) => {
  const message = new TextDecoder().decode(data)
  console.log("Received:", message)
})

// Send message
function sendMessage(text) {
  const encoder = new TextEncoder()
  const data = encoder.encode(text)
  channel.send(data)
}

// Leave when done
function cleanup() {
  channel.leave()
}
```

### Important: Data format
- `send()` accepts `Uint8Array` only (max 128,000 bytes)
- `setListener()` callback receives `Uint8Array`
- Use `TextEncoder`/`TextDecoder` for text
- Use binary formats for efficiency

### Example: Binary data
```javascript
const channel = window.webxdc.joinRealtimeChannel()

channel.setListener((data) => {
  // data is Uint8Array
  const view = new DataView(data.buffer)
  const x = view.getFloat32(0)
  const y = view.getFloat32(4)
  console.log("Position:", x, y)
})

function sendPosition(x, y) {
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setFloat32(0, x)
  view.setFloat32(4, y)
  channel.send(new Uint8Array(buffer))
}
```

## Error Handling

All APIs return Promises and may reject:

```javascript
try {
  await window.webxdc.sendToChat({ text: "Hello" })
} catch (error) {
  console.error("Failed to send:", error)
}
```

## Limitations

- **sendToChat**: File size limited to 100MB (configurable)
- **importFiles**: User must select files (no automatic access)
- **joinRealtimeChannel**: 
  - Max 128KB per message
  - Only one channel active per app instance
  - No delivery guarantees (UDP-like)
  - Expected latency: 100-300ms
