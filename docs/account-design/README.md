# Account Surface Design

Nebula's account surfaces use the existing dark glass, restrained cyan-violet
accents, large console typography, and short command rows. They avoid the
centered white-card pattern of a generic web login.

## First Run And Sign In

Desktop:

```text
+--------------------------------------------------------------------+
| NEBULA OS                                             SERVER ONLINE |
|                                                                    |
|  Make this server yours                 +-----------------------+  |
|  Create the first owner account.        | OWNER SETUP           |  |
|  Media stays local and shared.          | Account name          |  |
|                                         | Display name          |  |
|  01 Identity                            | Password / confirm    |  |
|  02 Secure this server                  | [ Create owner ]      |  |
|  03 Enter dashboard                     +-----------------------+  |
+--------------------------------------------------------------------+
```

The sign-in variant keeps the same stage, replaces setup guidance with the last
server target, and presents account name/password plus a primary `Enter Nebula`
command. Generic failure copy does not reveal whether an account exists.

Mobile (approximately 390 x 844):

```text
+------------------------------+
| safe area                    |
| NEBULA OS                    |
| Welcome back                 |
|                              |
| Account name                 |
| [________________________]   |
| Password                     |
| [________________________]   |
| [ Enter Nebula            ]  |
|                              |
| Session expired copy, if any |
|                   safe area  |
+------------------------------+
```

The stage scrolls as one column and pads all four edges with the shared
`--safe-area-*` variables. The first input receives focus on desktop, but mobile
does not force the keyboard open.

## Signed-In Identity Menu

The dashboard top bar adds a compact profile command beside system status:

```text
[ GPU status ] [ Controller ] [ JA  Jordan  Owner  v ] [ 9:41 ]
```

Opening it shows a console popover with `Account settings`, `Switch account`
(implemented as sign out to the profile entry screen in v1), and `Sign out`.
Escape closes the menu before closing any application surface.

## Account Settings

Settings adds an Account category before Client. It shows:

1. Profile: display name and read-only username/role.
2. Security: current password and new password/confirmation.
3. Sessions: current device first, last activity, expiration, and Revoke.
4. Sign out: a separated destructive command.

Success and failure messages stay inline so focus is not lost. Permission
denials use a full-width system state with `Return to Dashboard`; protected app
content is never rendered behind it.

## Expiration And Revocation

Any API `401` emits one global session-expired event. Nebula closes the current
app, clears only account-session client state, and renders sign in with a short
`Your session ended. Sign in again.` message. Server URL and an explicitly
configured legacy service token remain untouched.

## Keyboard And Controller

- Enter submits setup/sign-in when a form field is focused.
- Tab follows visual order through form commands.
- Escape closes the identity menu, then an active app, then a detail panel.
- Settings category buttons remain normal focusable controls.
- Destructive session/sign-out actions require an explicit button press; they
  are never bound to a global shortcut.

## Planned Follow-Up Surfaces

Role changes, account deletion, account avatars, a true profile chooser,
password recovery, MFA/passkeys, and native Keychain pairing are future work.
Owner-created member accounts and member enable/disable are implemented.
