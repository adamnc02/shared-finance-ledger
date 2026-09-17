import type { ReactNode } from 'react'
import { useLedgerData } from '../context/LedgerContext'
import { needsJointAccountSetup } from '../lib/jointAccountLedger'
import { JointAccountSetupModal } from './JointAccountSetupModal'

/**
 * App-wide checks that block interaction until resolved. Currently just
 * the joint account setup flow — deliberately checked here, once, rather
 * than inside Bills.tsx/Loans.tsx's own save handlers, so ANY path that
 * creates a joint-location bill/loan triggers it, with zero changes
 * needed to either of those (already-large) files.
 */
export function AppGuards({ children }: { children: ReactNode }) {
  const { data, setJointAccountOpening } = useLedgerData()

  return (
    <>
      {children}
      {needsJointAccountSetup(data) && (
        <JointAccountSetupModal onSave={(openingBalance, openingBalanceDate) => setJointAccountOpening(openingBalance, openingBalanceDate)} />
      )}
    </>
  )
}
