# Public web channel

An assistant in public mode can answer a chat on a website or another server
over HTTP. The owner turns it on in `/public-support` ("Website and API").

Endpoint: `/api/public/messages?agent=<agent id>` (shown on the same screen).

## From a browser

Allowed only from the websites the owner lists (CORS). No key is used.

```http
POST /api/public/messages?agent=<agent id>
Origin: https://shop.example.com
Content-Type: application/json

{ "message": "Hi, where is my order?" }
```

```json
{ "contact": "<token>", "text": "…", "outputs": [{ "tipo": "texto", "texto": "…" }] }
```

Send the `contact` token back on the next calls to keep the same
conversation. Brambit issues and signs it; a token it did not issue is
refused.

## From a server

```http
POST /api/public/messages?agent=<agent id>
Authorization: Bearer bpk_<key>
Content-Type: application/json

{ "message": "Hi, where is my order?", "contact": "customer-123" }
```

`contact` is your own id for the person (up to 200 characters) and is
required. Server contacts and browser contacts are kept apart.

The key:

- is shown once, when generated. Generating a new one stops the old one at
  once;
- goes on your server. A key in a website's code can be copied by
  anyone who opens the page;
- can be locked to your servers' addresses: list them under "Servers allowed
  to use the key" (one IP or CIDR range per line, up to 20, e.g.
  `203.0.113.7` or `203.0.113.0/24`). With a list, a call from any other
  address gets `403 ip_not_allowed`, even with the right key. An empty list
  accepts any address. How Brambit gets the address is in
  [Caller address](#caller-address).

### A photo with the message

A server call may send one photo for the assistant to look at, in `image`,
together with `message`:

```json
{ "message": "What do you think of this color on me?", "contact": "customer-123",
  "image": "data:image/jpeg;base64,/9j/4AAQ…" }
```

- `image`: a data URL or plain base64 of a JPEG, PNG or WebP, up to 1 MB
  decoded. Brambit reads the type from the bytes, not from the data URL.
- Only from a server, with the key. A browser call with `image` gets
  `400 image_needs_key`.
- Only with `message`, not with `event`.
- The photo is not stored. The model sees it in that turn only; the history
  keeps the text and the answer.
- The owner's model must read images (for example DeepSeek V4.1 Flash on
  Together). If it does not, the call returns the short "not available"
  notice in `text`.

## Page events

Instead of `message`, send `event` when the person does something that is
not typing:

```json
{ "event": { "type": "color_picked", "data": { "sku": "A1" } }, "contact": "<token>" }
```

`type`: lowercase letters, digits, `_`, `.` or `-`, starting with a letter,
up to 64 characters. `data`: an object, up to 2000 characters as JSON. A
call has `message` or `event`, never both.

## History

```http
GET /api/public/messages?agent=<agent id>
Brambit-Contact: <token or your id>
```

From a server, add the `Authorization` header as above. Returns the last 50
messages of that contact only:
`{ "messages": [{ "role", "text", "outputs"?, "event"?, "at" }] }`.

The contact goes in the header, not in the address: addresses are often kept
in proxy logs, and the browser token is enough to read the conversation.

## Limits

- 60 calls per minute per address (messages and history together).
- Body up to 64 KB, plus the photo when there is one.
- The public-support limits the owner sets in `/public-support` apply as on
  WhatsApp: messages per hour from each contact (default 30), messages per
  hour from all contacts together (default 1000) and the daily spending cap
  (default US$10). Past a limit the call still returns `200` with a short
  notice in `text`; for the per-contact limit only the first time in the
  hour, then `text: null`.

## Caller address

The limits per address and the key's address list use the caller's address.
Brambit listens on `127.0.0.1` (`HOST` in `.env`) and reads the address from
the last `X-Forwarded-For` entry, which the reverse proxy in front of it adds
(nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`).

With a load balancer in front of the proxy (an AWS ALB, for example), that
last entry is the load balancer's address, so every caller looks the same.
Tell the proxy to trust the load balancer and pass on the address it received
(nginx `realip` module):

```nginx
set_real_ip_from 10.0.0.0/16;   # your load balancer's addresses
real_ip_header X-Forwarded-For;
real_ip_recursive on;
```

Keep a proxy in front when Brambit is reachable from the internet. With
`HOST=0.0.0.0` and no proxy, a caller can write any address in
`X-Forwarded-For` and get around the limits.

## Errors

| Status | `error` | When |
| --- | --- | --- |
| 400 | `contact_required` | Server call without `contact`, or history without the `Brambit-Contact` header |
| 400 | `invalid_contact` | Browser token not issued by Brambit |
| 400 | `message_required` | No `message` and no `event` |
| 400 | `message_or_event` | Both `message` and `event` |
| 400 | `invalid_event` | `event` outside the rules above |
| 400 | `image_needs_key` | `image` in a browser call |
| 400 | `image_needs_message` | `image` without `message` |
| 400 | `invalid_image` | `image` is not a JPEG, PNG or WebP in base64 |
| 401 | `invalid_key` | Wrong or replaced key |
| 403 | `origin_not_allowed` | Browser call from a website not listed |
| 403 | `ip_not_allowed` | Server call from an address not listed |
| 404 | `not_found` | Unknown agent, public mode or the web channel off, or sign-up open on the installation |
| 413 | `body_too_large` | Body over 64 KB, not counting the photo |
| 413 | `image_too_large` | Photo over 1 MB decoded |
| 429 | | Too many calls from this address |
