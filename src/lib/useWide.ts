import { useEffect, useState } from 'react'
import { WIDE_QUERY } from './laptop'

/** True while the window is laptop-sized (`WIDE_QUERY`). Follows the query live, so resizing a window switches layout without a reload. */
export function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(WIDE_QUERY).matches)
  useEffect(() => {
    const mql = window.matchMedia?.(WIDE_QUERY)
    if (!mql) return
    const onChange = () => setWide(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return wide
}
