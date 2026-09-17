import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

BACKUP = os.environ.get('LEDGER_BACKUP') or str(Path(__file__).parent / 'fixtures' / 'backup-2026-08-24.json')
KEY = 'ledger:app-data-v2:v1'
data = json.load(open(BACKUP))

# Inject one synthetic, already-cleared, personal expense in a category
# that otherwise has no pending activity in the current window — this is
# exactly the reported bug's scenario (a category whose only content has
# cleared), made deterministic rather than depending on which category
# happens to be fully cleared in the real backup on whatever day this
# script runs.
import datetime
_gaming = next(c for c in data['categories'] if c['name'] == 'Gaming')
data['transactions'].append({
    'id': 'test-synthetic-cleared-only',
    'type': 'expense',
    'amount': 12.34,
    'date': datetime.date.today().isoformat(),
    'direction': 'out',
    'status': 'cleared',
    'location': 'personal',
    'ownerId': data['primaryPersonId'],
    'categoryId': _gaming['id'],
    'paymentMethod': 'cash',  # 'card' buckets into the Credit Card group regardless of categoryId (see groupingCategoryId in Home.tsx) — cash keeps this in its own Gaming group
    'note': 'Synthetic cleared-only test row',
})

fails = []
def check(label, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + label + ('' if cond or not detail else '\n        ' + detail))
    if not cond:
        fails.append(label)

def set_dropdown(page, label, option):
    """InlineDropdown: click the labelled trigger, then the option."""
    page.get_by_text(label, exact=False).first.click()
    page.wait_for_timeout(150)
    page.get_by_text(option, exact=True).last.click()
    page.wait_for_timeout(300)

def switch(page, name):
    return page.get_by_role('switch', name=name)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 420, 'height': 1400})
    errors = []
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))

    page.goto('http://127.0.0.1:5173/')
    page.wait_for_timeout(800)
    # Seed via evaluate + reload — page.goto alone does not re-trigger loadLedgerData().
    page.evaluate("([k, v]) => localStorage.setItem(k, v)", [KEY, json.dumps(data)])
    page.reload()
    page.wait_for_timeout(1800)

    print('\n=== A. Defaults on load ===')
    check('"Next 3 cycles" is the selected cycle pill', page.get_by_text('Next 3 cycles', exact=True).count() >= 1)
    check('Cycle-end totals switch present by default (Next 3 cycles + List + Date)', switch(page, 'Cycle-end totals').count() == 1)
    check('Cycle-end totals is ON by default', switch(page, 'Cycle-end totals').get_attribute('aria-checked') == 'true')
    check('Show cleared switch present by default', switch(page, 'Show cleared').count() == 1)
    check('Show cleared is OFF by default', switch(page, 'Show cleared').get_attribute('aria-checked') == 'false')
    check('a "Current cycle" section header rendered by default', page.get_by_text('Current cycle', exact=True).count() >= 1)

    print('\n=== B. Cycle-end totals switch visibility across control combinations (Show cleared stays present throughout) ===')
    set_dropdown(page, 'Order by', 'Amount')
    check('Next 3 cycles + List + Amount: Cycle-end totals hidden', switch(page, 'Cycle-end totals').count() == 0)
    check('...Show cleared still present', switch(page, 'Show cleared').count() == 1)
    set_dropdown(page, 'Order by', 'Date')
    check('...back to Date: Cycle-end totals shown again', switch(page, 'Cycle-end totals').count() == 1)

    set_dropdown(page, 'Group by', 'Category')
    check('Next 3 cycles + Category: Cycle-end totals hidden', switch(page, 'Cycle-end totals').count() == 0)
    check('...Show cleared still present', switch(page, 'Show cleared').count() == 1)
    set_dropdown(page, 'Group by', 'List')
    check('...back to List: Cycle-end totals shown again', switch(page, 'Cycle-end totals').count() == 1)

    page.get_by_text('This cycle', exact=True).first.click()
    page.wait_for_timeout(400)
    check('This cycle: Cycle-end totals hidden', switch(page, 'Cycle-end totals').count() == 0)
    check('...Show cleared still present', switch(page, 'Show cleared').count() == 1)
    page.get_by_text('Next 3 cycles', exact=True).first.click()
    page.wait_for_timeout(400)
    check('back to Next 3 cycles: Cycle-end totals shown again', switch(page, 'Cycle-end totals').count() == 1)

    print('\n=== C. Switching Cycle-end totals off ===')
    check('Cycle-end totals starts on (default)', switch(page, 'Cycle-end totals').get_attribute('aria-checked') == 'true')
    switch(page, 'Cycle-end totals').click()
    page.wait_for_timeout(600)
    check('Cycle-end totals now off', switch(page, 'Cycle-end totals').get_attribute('aria-checked') == 'false')
    check('no cycle section headers once off', page.get_by_text('Current cycle', exact=True).count() == 0)
    # Switch back on for the rest of the checks (matches the default state).
    switch(page, 'Cycle-end totals').click()
    page.wait_for_timeout(600)
    check('Cycle-end totals back on', switch(page, 'Cycle-end totals').get_attribute('aria-checked') == 'true')

    print('\n=== D. Default collapse states (cycle-end totals) ===')
    subtotals = page.get_by_text('Balance at', exact=False)
    print(f'        section subtotal rows visible: {subtotals.count()}')
    check('0 subtotal rows visible (4 sections, all collapsed)', subtotals.count() == 0, f'got {subtotals.count()}')

    cur = page.get_by_text('Current cycle', exact=True).first
    row = cur.locator('xpath=ancestor::button[1]')
    row_text = row.inner_text()
    check('collapsed Current cycle header shows a £ figure', '£' in row_text, repr(row_text))

    row.click()
    page.wait_for_timeout(500)
    row_text2 = page.get_by_text('Current cycle', exact=True).first.locator('xpath=ancestor::button[1]').inner_text()
    check('expanded Current cycle header shows NO figure', '£' not in row_text2, repr(row_text2))
    check('expanding adds a 1st subtotal row', page.get_by_text('Balance at', exact=False).count() == 1, f'got {page.get_by_text("Balance at", exact=False).count()}')
    row.click()  # collapse back down for the checks below
    page.wait_for_timeout(400)

    print('\n=== E. "Show cleared" OFF (default): cleared payments hidden everywhere, including from category totals ===')
    # Real backup data — every real backup accumulates cleared history, so
    # this catches a leaky hide directly rather than relying on a
    # synthetic fixture. Cycle-grouped view (currently active, current
    # cycle re-expanded below).
    row.click()
    page.wait_for_timeout(400)
    check('no bold "Cleared" label anywhere (cycle-end totals view)', 'Cleared' not in page.inner_text('body'))
    row.click()
    page.wait_for_timeout(300)

    switch(page, 'Cycle-end totals').click()  # -> plain date-ordered list
    page.wait_for_timeout(500)
    check('no "Cleared" label in the plain date-ordered view either', 'Cleared' not in page.inner_text('body'))

    set_dropdown(page, 'Order by', 'Amount')
    check('no "Cleared" label in the amount-ordered view', 'Cleared' not in page.inner_text('body'))
    set_dropdown(page, 'Order by', 'Date')

    set_dropdown(page, 'Group by', 'Category')
    personal_card = page.locator('h2', has_text='Personal').locator('xpath=..')
    body = personal_card.inner_text()
    check('no "Cleared" label in the category-grouped view', 'Cleared' not in body)

    def category_headers(card):
        """{name: header button's own text} for every rendered category group."""
        out = {}
        for btn in card.get_by_role('button').all():
            txt = btn.inner_text().strip()
            first_line = txt.splitlines()[0] if txt else ''
            if first_line and '£' in txt:
                out[first_line] = txt
        return out

    headers_off = category_headers(personal_card)
    print(f'        categories visible with Show cleared OFF: {sorted(headers_off.keys())}')

    print('\n=== F. "Show cleared" ON: cleared rows reappear, WITH the category total now including them ===')
    switch(page, 'Show cleared').click()
    page.wait_for_timeout(500)
    check('Show cleared now on', switch(page, 'Show cleared').get_attribute('aria-checked') == 'true')
    body = personal_card.inner_text()
    check('"Cleared" label now appears in the category-grouped view', 'Cleared' in body)

    headers_on = category_headers(personal_card)
    print(f'        categories visible with Show cleared ON:  {sorted(headers_on.keys())}')
    # This is the reported bug, tested generically rather than pinned to
    # one category name (which real category ends up fully cleared varies
    # run to run, since it depends on today's date against the fixture):
    # turning cleared payments ON can only ever ADD categories/amount to
    # what's shown, never remove any — a category with SOME pending items
    # was already visible with the toggle off, and its total can only grow
    # once cleared rows are folded back in.
    check('every category visible with the toggle off is still visible with it on', set(headers_off) <= set(headers_on), f'off={set(headers_off)} on={set(headers_on)}')
    # The deterministic case: the synthetic cleared-only "Gaming" row
    # injected at the top of this script — exactly the reported bug's
    # scenario, made reproducible regardless of the real backup's mix of
    # cleared/pending on whatever day this runs.
    check('"Gaming" (synthetic, cleared-only) is hidden with the toggle off', 'Gaming' not in headers_off)
    check('"Gaming" appears once the toggle is switched on', 'Gaming' in headers_on)
    if 'Gaming' in headers_on:
        check('"Gaming" shows a nonzero total once visible', '£0.00' not in headers_on['Gaming'], headers_on['Gaming'])

    def total_from_header(text):
        import re
        m = re.search(r'[+-]£[\d,]+\.\d\d', text)
        return abs(float(m.group(0).replace('£', '').replace(',', ''))) if m else None

    grew_or_equal = True
    for name in headers_off:
        off_total = total_from_header(headers_off[name])
        on_total = total_from_header(headers_on.get(name, ''))
        if off_total is not None and on_total is not None and on_total < off_total - 0.001:
            grew_or_equal = False
            print(f'        {name}: OFF total {off_total} > ON total {on_total} (should never shrink)')
    check('no shared category\'s total shrank when cleared payments were included', grew_or_equal)

    print('\n=== G. Turning "Show cleared" back off restores the hidden state (list view too) ===')
    set_dropdown(page, 'Group by', 'List')
    switch(page, 'Cycle-end totals').click()  # restore default cycle-end-totals-on state
    page.wait_for_timeout(400)
    switch(page, 'Show cleared').click()
    page.wait_for_timeout(500)
    check('Show cleared back off', switch(page, 'Show cleared').get_attribute('aria-checked') == 'false')
    check('Cycle-end totals back on', switch(page, 'Cycle-end totals').get_attribute('aria-checked') == 'true')

    print('\n=== H. Console clean ===')
    ignorable = ('favicon', 'fonts.googleapis', 'fonts.gstatic', 'status of 403')
    real = [e for e in errors if not any(x in e.lower() for x in ignorable)]
    check('no console/page errors', len(real) == 0, '\n        '.join(real[:5]))

    page.screenshot(path='/tmp/shot-cycle-totals.png', full_page=True)
    browser.close()

print('\n' + ('ALL BROWSER CHECKS PASSED' if not fails else f'{len(fails)} FAILED: ' + '; '.join(fails)))
sys.exit(0 if not fails else 1)
