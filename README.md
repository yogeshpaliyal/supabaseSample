# Vanshavali — village family tree

A mobile-first family tree for a whole village, with per-tree access control.
Backend is Supabase (Postgres + Auth + row-level security); the frontend is a static
site in `web/` deployed to GitHub Pages.

## Features

- **Roles per tree**: viewer (read), contributor (suggest changes), editor (edit + approve), owner (manage members)
- **Edit requests**: contributors' changes wait in a review inbox with a before → after diff
- **Join flow**: share `…/?tree=<id>`; people sign in and request access; owners approve with a role.
  Owners can also pre-invite by email (access applies on first sign-in).
- **Audit log** of every change (who, what, when)
- Indian family structures: multiple marriages (♥1 ♥2, ended by death/separation), adoption
  (god lena — shown under the adoptive family), aata-saata and cousin marriages (people are never
  drawn twice; "↪" cards jump to where they are)
- Tree: pan / pinch-zoom, collapsible branches, find-and-focus, ancestors view
- Profiles with parents, spouses, children by marriage, half/full siblings
- Relationship finder with Hindi kinship terms (Chacha, Mama, Bua, Bhabhi, …)

## Layout

```
supabase/migrations/   schema, RLS policies and RPC functions (apply in order)
web/                   static app (index.html, app.js, api.js, style.css, config.js)
.github/workflows/     GitHub Pages deploy
```

All writes go through `security definer` RPCs (`save_person`, `delete_person`,
`submit_edit_request`, `review_edit_request`, `invite_member`, …) that check the caller's role.
Tables are read-only to clients and protected by RLS; anonymous users can read nothing.

## One-time setup

1. **GitHub Pages**: Settings → Pages → Source: *GitHub Actions*. Pushing to `main` deploys `web/`.
   The site will be at `https://<user>.github.io/<repo>/`.
2. **Supabase Auth URLs**: Dashboard → Authentication → URL Configuration
   - Site URL: your Pages URL
   - Redirect URLs: your Pages URL (and `http://localhost:8000/**` for local testing)
3. **Google sign-in**: create an OAuth client (Web) in Google Cloud Console with redirect URI
   `https://<project-ref>.supabase.co/auth/v1/callback`, then paste the client ID/secret into
   Dashboard → Authentication → Providers → Google.
4. Email magic links use Supabase's built-in mailer, which only sends to members of your Supabase
   team. For relatives, use Google sign-in, or configure custom SMTP.

## Local development

```
cd web && python3 -m http.server 8000
```
