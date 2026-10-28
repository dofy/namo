# Workbench UI conventions

The workbench uses a light gray canvas, white content panels, and orange for
active choices and primary actions. Keep the existing sidebar and compact record
tables. Design for both Chinese and English, including 320 px mobile screens.

## Page structure

- Use the shared page header in `ui/App.tsx`: icon, title, one sentence explaining
  the page, and refresh status. Align content to the same page edges.
- Group related settings with `PageSection` and `SectionHeading`. Each section
  should explain a user goal; avoid exposing schema versions or migration terms
  as the main status. Keep troubleshooting metadata available in its own area.
- Use `SettingToggle` for independent choices. The whole card is a keyboard
  accessible switch with a title, icon, short explanation, and visible state.
- On mobile, put a small icon, title, and switch on one row, with the explanation
  below. Use compact spacing and hide redundant visual on/off text; keep the
  accessible checked state and the whole-card touch target.
- Keep tasks and sessions in tables. Separate search filters from results and
  keep pagination beside the results. Use `EmptyState` to explain what to do next.
- Put optional setup instructions, advanced parameters, source records, and
  history in native disclosures. Do not hide errors or required confirmations.
- Keep explanatory text within the available panel width. Do not insert manual
  line breaks to fit one screen size. Long identifiers must wrap or scroll locally.

## Interaction and safety

- Show save actions with the form they affect. Pin the action bar only while
  there are unsaved changes; it should not obscure an untouched form.
- Preserve drafts, revision conflicts, disabled states, and confirmation dialogs.
  A visual redesign must not change permissions or bypass an existing confirmation.
- Keep settings and profile drafts mounted when navigating or changing tabs.
- Keep independent forms independent, including the per-user model setting.
- State whether a setting requires saving, applying, or affects only new tasks.
  Use wording supported by actual behavior.

## Verification

Use isolated API fixtures to inspect all routes, both memory tabs, and editors.
Check desktop and narrow screens in both languages, then exercise keyboard
switches, filtering, failed saves, discarded drafts, tab navigation, and dialog
closing. Do not change real settings or restart the receiver for visual checks.
Run `pnpm test` before delivery. Store screenshots and local browser scripts in
ignored `output/playwright/`, without credentials or production user content.
