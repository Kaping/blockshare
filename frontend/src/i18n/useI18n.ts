import { useEffect, useState } from 'react'
import { getLocale, onLocaleChange, setLocale, t } from './index'

export function useI18n() {
  const [locale, setLocaleState] = useState(getLocale())

  useEffect(() => {
    const unsubscribe = onLocaleChange(() => {
      setLocaleState(getLocale())
    })
    return () => unsubscribe()
  }, [])

  return {
    locale,
    setLocale,
    t,
  }
}

