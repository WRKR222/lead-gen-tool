// Country -> currency, used so every client's value pyramid is priced in
// the currency of the market that client actually sells in.
const CURRENCY_BY_COUNTRY = {
  KE: 'KES', UG: 'UGX', TZ: 'TZS', RW: 'RWF', BI: 'BIF', SS: 'SSP', ET: 'ETB', SO: 'SOS', DJ: 'DJF', CD: 'CDF',
  NG: 'NGN', GH: 'GHS', ZA: 'ZAR', EG: 'EGP', MA: 'MAD', ZM: 'ZMW', MW: 'MWK', MZ: 'MZN', SN: 'XOF', CI: 'XOF',
  BW: 'BWP', NA: 'NAD', ZW: 'USD', CM: 'XAF',
  US: 'USD', CA: 'CAD', MX: 'MXN', BR: 'BRL', AR: 'ARS', CL: 'CLP', CO: 'COP',
  GB: 'GBP', IE: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', BE: 'EUR', PT: 'EUR', AT: 'EUR', FI: 'EUR',
  SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CH: 'CHF',
  IN: 'INR', CN: 'CNY', JP: 'JPY', SG: 'SGD', AE: 'AED', SA: 'SAR', QA: 'QAR', ID: 'IDR', PH: 'PHP', MY: 'MYR',
  AU: 'AUD', NZ: 'NZD'
};

// Approximate units of local currency per 1 USD. Only used to scale the
// offline (no-AI) value-pyramid template into a sensible local price
// range; every price stays editable, and the AI path prices directly in
// the local currency.
const APPROX_PER_USD = {
  USD: 1, KES: 129, UGX: 3700, TZS: 2600, RWF: 1400, BIF: 2900, SSP: 4500, ETB: 120, SOS: 570, DJF: 178, CDF: 2800,
  NGN: 1550, GHS: 15, ZAR: 18, EGP: 49, MAD: 10, ZMW: 27, MWK: 1740, MZN: 64, XOF: 600, XAF: 600, BWP: 13.5, NAD: 18,
  CAD: 1.37, MXN: 18, BRL: 5.5, ARS: 1000, CLP: 950, COP: 4000,
  GBP: 0.79, EUR: 0.92, SEK: 10.5, NOK: 10.7, DKK: 6.9, PLN: 4, CHF: 0.88,
  INR: 84, CNY: 7.2, JPY: 150, SGD: 1.35, AED: 3.67, SAR: 3.75, QAR: 3.64, IDR: 16000, PHP: 57, MYR: 4.5,
  AUD: 1.52, NZD: 1.66
};

function currencyForCountry(countryCode) {
  return CURRENCY_BY_COUNTRY[(countryCode || '').toUpperCase()] || 'USD';
}

function approxPerUsd(currency) {
  return APPROX_PER_USD[currency] || 1;
}

module.exports = { CURRENCY_BY_COUNTRY, currencyForCountry, approxPerUsd };
