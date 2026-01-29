import { useI18n } from '../i18n/useI18n'
import './LanguageSelector.css'

function LanguageSelector() {
  const { locale, setLocale, t } = useI18n()

  return (
    <div className="language-selector">
      <label htmlFor="language-select">{t('ui.languageLabel')}</label>
      <select
        id="language-select"
        value={locale}
        onChange={(e) => setLocale(e.target.value as 'ko' | 'en')}
      >
        <option value="ko">{t('ui.languageOptions.ko')}</option>
        <option value="en">{t('ui.languageOptions.en')}</option>
      </select>
    </div>
  )
}

export default LanguageSelector

