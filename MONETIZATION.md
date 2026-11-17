# Making money with OpenTalk

OpenTalk is free and MIT-licensed. If you host a public instance, these are the built-in ways to cover costs or earn from it, roughly from easiest to most work. Each one is switched on with a setting in `.env`, with no code changes.

## 1. Donation button (easiest)

```env
DONATE_URL=https://ko-fi.com/yourname
DONATE_LABEL=☕ Support this chat
```

This shows a button on the landing page and in the chat header. Any link works:

- **Ko-fi** or **Buy Me a Coffee**: free to set up, with one-off and monthly support. Ko-fi takes 0% on donations.
- **GitHub Sponsors**: good if people find you through the repo.
- **Stripe Payment Link**: your own branded checkout, standard Stripe fees.

Free tools that people use regularly tend to get donations best when the ask is visible but polite, which is how the button is placed.

## 2. Self-hosted sponsor banner (best value for a niche or local audience)

```env
SPONSOR_TEXT=Hosted by JorahOne — managed IT for small business
SPONSOR_URL=https://jorahone.com
```

This adds a thin "SPONSOR" strip at the top of every chat room. **You** sell this spot directly, for example as a flat monthly fee to a local business, a community group or an event. There's no ad network, no trackers and no approval process, and you keep 100%. Links get `rel="sponsored"` for SEO compliance.

To start, use it to promote your own business (JorahOne, TRANKILO). Once you have regular traffic, sell it, and show sponsors the `/stats` endpoint as proof of activity.

## 3. Google AdSense

```env
ADSENSE_CLIENT=ca-pub-XXXXXXXXXXXXXXXX
ADSENSE_SLOT_HOME=1234567890   # responsive ad under the landing card
ADSENSE_SLOT_CHAT=0987654321   # ad in the "Online" side panel (desktop)
```

When `ADSENSE_CLIENT` is set, OpenTalk:

- loads the AdSense script and renders the ad slots,
- serves `/ads.txt` automatically,
- switches to Google's recommended strict CSP (per-request nonce + `strict-dynamic`). With ads off, no Google scripts ever load.

Things to know first:

- **You need AdSense approval** for your domain. Google wants real content beyond a chat box, so add an About page or blog on the main site.
- **User-generated content must be moderated.** AdSense policy holds you responsible for what's shown next to ads. Set `ADMIN_KEY`, fill in `blocked-words.txt`, and keep `LOBBY_LINKS=0`. If the lobby goes unmoderated, consider `ENABLE_LOBBY=0` (private rooms only) or keep ads to the landing page only (leave `ADSENSE_SLOT_CHAT` empty).
- **Expect modest income.** Chat pages get long sessions but few ad impressions per visit. Ads usually cover hosting before they become real income, and donations or a direct sponsor often earn more.
- Visitors in the EU/UK need a consent banner (a Google-certified CMP) when ads are on.

## 4. Bigger ideas (not built in yet)

- **Hosted or white-label chat for businesses:** run branded instances (`SITE_NAME`, your colors) for schools, events, churches, communities or customer-support lobbies, and charge a monthly hosting fee. The MIT license allows this.
- **Paid "Pro" rooms:** custom room codes, bigger rooms, longer history, password rooms. This needs a Stripe integration and some session state, so contributions are welcome.
- **Embeddable widget:** a `<script>` chat bubble other sites can drop in. Free tier with a "Powered by OpenTalk" link, paid tier without it.

---
*Nothing here is legal or tax advice. Check AdSense and payment-provider terms for your country.*
