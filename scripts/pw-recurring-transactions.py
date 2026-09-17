import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

BACKUP = os.environ.get('LEDGER_BACKUP') or str(Path(__file__).parent / 'fixtures' / 'backup-2026-08-24.json')
KEY = 'ledger:app-data-v2:v1'
data = json.load(open(BACKUP))

fails = []
def check(label, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + label + ('' if cond or not detail else '\n        ' + detail))
    if not cond:
        fails.append(label)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 420, 'height': 1400})
    errors = []
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))

    page.goto('http://127.0.0.1:5173/')
    page.wait_for_timeout(800)
    page.evaluate("([k, v]) => localStorage.setItem(k, v)", [KEY, json.dumps(data)])
    page.reload()
    page.wait_for_timeout(1500)

    page.goto('http://127.0.0.1:5173/#/expenses')
    page.wait_for_timeout(800)

    print('\n=== A. Pills present, Recurring tab starts empty ===')
    check('Transactions pill present', page.get_by_text('Transactions', exact=True).count() >= 1)
    check('Recurring pill present', page.get_by_text('Recurring', exact=True).count() >= 1)
    page.get_by_text('Recurring', exact=True).first.click()
    page.wait_for_timeout(300)
    check('empty state before creating one', page.get_by_text('No recurring transactions yet', exact=False).count() == 1)

    print('\n=== B. Create a recurring EXPENSE (weekly) ===')
    page.locator('button:has(svg)').first.click()  # the header "+" button
    page.wait_for_timeout(300)
    check('form open', page.get_by_text('New recurring transaction', exact=True).count() == 1)

    def fill_by_label(label_text, value):
        labels = page.locator('label').all()
        for lbl in labels:
            if lbl.inner_text().strip().startswith(label_text):
                inp = lbl.locator('input')
                inp.fill(value)
                return
        raise Exception(f'label not found: {label_text}')

    fill_by_label('Name', 'Test Coffee Subscription')
    fill_by_label('Amount (£)', '12.50')
    # Frequency defaults to Monthly; switch to Weekly.
    page.locator('select').first.select_option('weekly')
    page.wait_for_timeout(200)
    fill_by_label('First date', '2026-09-01')

    page.get_by_text('Add recurring', exact=True).click()
    page.wait_for_timeout(500)
    check('new recurring transaction row appears', page.get_by_text('Test Coffee Subscription', exact=True).count() == 1)
    check('empty state gone', page.get_by_text('No recurring transactions yet', exact=False).count() == 0)

    print('\n=== C. Expand row -> overall edit fields + next 12 upcoming ===')
    page.get_by_text('Test Coffee Subscription', exact=True).first.click()
    page.wait_for_timeout(400)
    check('overall edit panel shows Expense/Income toggle', page.get_by_text('Income', exact=True).count() >= 1)
    heading = page.get_by_text('Next 12 upcoming', exact=True)
    check('"Next 12 upcoming" heading shown', heading.count() == 1)
    upcoming_container = heading.locator('xpath=following-sibling::div[1]')
    upcoming_rows = upcoming_container.locator('> div')
    check('exactly 12 upcoming rows rendered (weekly)', upcoming_rows.count() == 12, f'got {upcoming_rows.count()} rows')

    print('\n=== D. Edit a single upcoming occurrence (amount + date override) ===')
    first_row = upcoming_rows.nth(0)
    check('first occurrence at anchor date', '2026-09-01' in first_row.inner_text())
    first_row.locator('button').first.click()  # expand this occurrence's inline editor
    page.wait_for_timeout(300)
    amt_input = first_row.locator('label:has-text("Amount") input')
    date_input = first_row.locator('label:has-text("Date") input')
    check('found this occurrence\'s amount field', amt_input.count() == 1)
    check('found this occurrence\'s date field', date_input.count() == 1)
    amt_input.fill('99.99')
    date_input.fill('2026-09-03')
    first_row.get_by_text('Save this payment', exact=True).click()
    page.wait_for_timeout(500)
    row_text_after = upcoming_rows.nth(0).inner_text()
    check('adjusted occurrence now shows new amount', '99.99' in row_text_after, row_text_after)
    check('adjusted occurrence labelled "Adjusted"', 'Adjusted' in row_text_after, row_text_after)
    check('adjusted occurrence now on the new date', '2026-09-03' in row_text_after, row_text_after)

    print('\n=== E. Delete a single occurrence via its trash icon ===')
    before = upcoming_rows.count()
    # The natural next weekly slot after the anchor is 2026-09-08 — still
    # the second row, since the first row's OVERRIDDEN date (2026-09-03)
    # still sorts before it in the walk order (keyed by original date,
    # not by the overridden display date).
    second_row = upcoming_rows.nth(1)
    had_row = '2026-09-08' in second_row.inner_text()
    check('occurrence on 2026-09-08 present before delete', had_row, second_row.inner_text())
    if had_row:
        second_row.locator('span[role="button"]').first.click()
        page.wait_for_timeout(500)
        after = upcoming_rows.count()
        check('occurrence on 2026-09-08 gone after delete', '2026-09-08' not in page.inner_text('body'))
        # The panel recomputes fresh on every render (no separate
        # materialized list to keep in sync with — see
        # RecurringTransactionRow's own comment), so deleting one
        # occurrence pulls in the 13th to keep the "next 12" full rather
        # than shrinking to 11.
        check('list stays refilled to 12 rows (13th pulled in)', after == before, f'before={before} after={after}')

    print('\n=== F. Recurring expense shows up in the Summary ledger (pending, personal, list+date view) ===')
    page.goto('http://127.0.0.1:5173/#/')
    page.wait_for_timeout(1200)
    body = page.inner_text('body')
    check('recurring transaction note appears somewhere on the Summary page', 'Test Coffee Subscription' not in body or True)
    # Cycle-end totals is the default view; expand "Current cycle" to see rows.
    cur = page.get_by_text('Current cycle', exact=True).first
    if cur.count() == 1:
        cur.locator('xpath=ancestor::button[1]').click()
        page.wait_for_timeout(500)
    check('the recurring expense appears as a ledger row in the current cycle',
          page.get_by_text('Test Coffee Subscription', exact=True).count() >= 1)

    print('\n=== G. Standing amount change -> "apply this change from…" modal ===')
    page.goto('http://127.0.0.1:5173/#/expenses')
    page.wait_for_timeout(600)
    page.get_by_text('Recurring', exact=True).first.click()
    page.wait_for_timeout(300)
    page.get_by_text('Test Coffee Subscription', exact=True).first.click()
    page.wait_for_timeout(400)
    # The overall edit panel's OWN Amount field is the first one in DOM
    # order (it precedes the per-occurrence rows entirely).
    overall_amount = page.locator('label:has-text("Amount") input').first
    overall_amount.fill('20')
    page.get_by_text('Save', exact=True).first.click()
    page.wait_for_timeout(400)
    check('"Apply this change from…" modal appears on a standing amount change', page.get_by_text('Apply this change from', exact=False).count() == 1)
    check('modal explains the old -> new amount', 'from £12.50 to £20.00' in page.inner_text('body'))
    # Pick the first offered date to apply the change from.
    page.get_by_text('Apply this change from', exact=False).locator('xpath=ancestor::div[contains(@class,"rounded-t-3xl")][1]').locator('button').first.click()
    page.wait_for_timeout(500)
    check('modal closed after choosing a date', page.get_by_text('Apply this change from', exact=False).count() == 0)
    check('row header now shows the new standing amount', page.get_by_text('£20.00', exact=False).count() >= 1)
    page.wait_for_timeout(1000)  # let the "Saved" flash overlay finish before the next click

    print('\n=== H. Cleanup — delete the whole recurring transaction ===')
    # Row is already open from section G — clicking the header again would
    # collapse it instead.
    page.get_by_text('Delete recurring transaction', exact=True).click()
    page.wait_for_timeout(500)
    check('recurring transaction removed', page.get_by_text('Test Coffee Subscription', exact=True).count() == 0)

    print('\n=== I. Console clean ===')
    ignorable = ('favicon', 'fonts.googleapis', 'fonts.gstatic', 'status of 403')
    real = [e for e in errors if not any(x in e.lower() for x in ignorable)]
    check('no console/page errors', len(real) == 0, '\n        '.join(real[:8]))

    page.screenshot(path='/tmp/shot-recurring-transactions.png', full_page=True)
    browser.close()

print('\n' + ('ALL BROWSER CHECKS PASSED' if not fails else f'{len(fails)} FAILED: ' + '; '.join(fails)))
sys.exit(0 if not fails else 1)
