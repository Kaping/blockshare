import koUi from './locales/ko/ui.json'
import koSession from './locales/ko/session.json'
import koError from './locales/ko/error.json'
import koBlock from './locales/ko/block.json'
import enUi from './locales/en/ui.json'
import enSession from './locales/en/session.json'
import enError from './locales/en/error.json'
import enBlock from './locales/en/block.json'

export type Locale = 'ko' | 'en'

const STORAGE_KEY = 'blockshare_language'

const dictionaries = {
  ko: {
    ui: koUi,
    session: koSession,
    error: koError,
    block: koBlock,
  },
  en: {
    ui: enUi,
    session: enSession,
    error: enError,
    block: enBlock,
  },
} as const

type DictionaryRoot = typeof dictionaries

let currentLocale: Locale = (localStorage.getItem(STORAGE_KEY) as Locale) || 'ko'
const listeners = new Set<() => void>()

export function getLocale(): Locale {
  return currentLocale
}

export function setLocale(locale: Locale) {
  if (currentLocale === locale) return
  currentLocale = locale
  localStorage.setItem(STORAGE_KEY, locale)
  listeners.forEach(listener => listener())
}

export function onLocaleChange(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getValue(locale: Locale, key: string): string | undefined {
  const parts = key.split('.')
  let cursor: any = (dictionaries as DictionaryRoot)[locale]
  for (const part of parts) {
    cursor = cursor?.[part]
  }
  return typeof cursor === 'string' ? cursor : undefined
}

export function t(key: string, params?: Record<string, string | number>): string {
  const value = getValue(currentLocale, key) ?? getValue('ko', key) ?? key
  if (!params) return value
  return Object.keys(params).reduce((acc, paramKey) => {
    return acc.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(params[paramKey]))
  }, value)
}

