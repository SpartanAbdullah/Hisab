// ISO 4217 currency catalogue — the single source of truth for currency
// metadata in Hisaab.
//
// FOUNDER DECISION (2026-09-04): Hisaab supports EVERY active ISO 4217
// currency, not the original eight. The old list lives on as
// `LEGACY_CURRENCIES` (and as `SUPPORTED_CURRENCIES` in src/db/types.ts)
// because the Postgres CHECK constraint still only accepts those eight until
// the ISO widening migration is applied. Until then:
//
//   LEGACY_CURRENCIES  = what the DATABASE accepts today
//   CURRENCY_CODES     = what the APP knows about (full ISO list)
//
// Do not conflate them. Writing a non-legacy code before the migration lands
// will be rejected by Postgres, not by this module.
//
// WHAT IS IN HERE
//   - every active ISO 4217 currency (fund codes, precious metals, testing
//     codes and supranational bond codes are deliberately excluded — they are
//     not money a person records in a khata)
//   - `minorUnits`: the ISO decimal places. Most are 2; JPY/KRW/VND/CLP/ISK
//     and the African francs are 0; the Gulf/North-African dinars are 3.
//     Money formatting and rounding MUST go through `currencyMinorUnits` /
//     `roundMoney` rather than assuming cents.
//   - `symbol`: the eight legacy symbols are pinned to EXACTLY what the app
//     already renders, so no existing statement, receipt or PDF changes.
//   - `name.ur`: roman Urdu (Latin script), per the repo i18n convention.
//     Falls back to the English name where no common Urdu name exists.
//   - `aliases`: what a Pakistani/Gulf-diaspora user actually types —
//     "dirham", "emirates", "rupaya", "درہم" — matched case- and
//     diacritic-insensitively by `searchCurrencies`.
//
// Pure module: no React, no DB, no i18n import. Colocated test in
// currencies.test.ts.

export interface CurrencyMeta {
  code: string;
  name: { en: string; ur: string };
  symbol: string;
  minorUnits: 0 | 2 | 3;
  aliases: string[];
  regions: string[];
}

/**
 * The eight codes the Postgres CHECK constraint accepts until the ISO
 * widening migration is applied. Mirrors `SUPPORTED_CURRENCIES` in
 * src/db/types.ts — currencies.test.ts asserts the two never drift.
 */
export const LEGACY_CURRENCIES = ['AED', 'PKR', 'PHP', 'SAR', 'QAR', 'OMR', 'KWD', 'BHD'] as const;

// ── Raw table ────────────────────────────────────────────────────────────────
// [code, englishName, symbol, minorUnits, romanUrduName, aliases, regions]
// A '' roman-Urdu name means "same as English". Aliases and regions are
// '|'-separated to keep the table one line per currency and reviewable.
type Row = readonly [string, string, string, 0 | 2 | 3, string, string, string];

const RAW: readonly Row[] = [
  ['AED', 'UAE Dirham', 'AED', 2, 'Emarati Dirham', 'dirham|emirates|uae|dubai|abu dhabi|درہم|درهم', 'United Arab Emirates'],
  ['AFN', 'Afghan Afghani', '؋', 2, 'Afghani', 'afghani|afghanistan|kabul|افغانی', 'Afghanistan'],
  ['ALL', 'Albanian Lek', 'L', 2, '', 'lek|albania', 'Albania'],
  ['AMD', 'Armenian Dram', '֏', 2, '', 'dram|armenia', 'Armenia'],
  ['ANG', 'Netherlands Antillean Guilder', 'ƒ', 2, '', 'guilder|antilles|curacao', 'Curaçao|Sint Maarten'],
  ['AOA', 'Angolan Kwanza', 'Kz', 2, '', 'kwanza|angola', 'Angola'],
  ['ARS', 'Argentine Peso', '$', 2, '', 'peso|argentina', 'Argentina'],
  ['AUD', 'Australian Dollar', 'A$', 2, 'Australian Dollar', 'dollar|australia|aussie|ڈالر', 'Australia'],
  ['AWG', 'Aruban Florin', 'ƒ', 2, '', 'florin|aruba', 'Aruba'],
  ['AZN', 'Azerbaijani Manat', '₼', 2, '', 'manat|azerbaijan|baku', 'Azerbaijan'],
  ['BAM', 'Bosnia-Herzegovina Convertible Mark', 'KM', 2, '', 'mark|bosnia', 'Bosnia and Herzegovina'],
  ['BBD', 'Barbadian Dollar', '$', 2, '', 'dollar|barbados', 'Barbados'],
  ['BDT', 'Bangladeshi Taka', '৳', 2, 'Bangladeshi Taka', 'taka|bangladesh|dhaka|ٹکا', 'Bangladesh'],
  ['BGN', 'Bulgarian Lev', 'лв', 2, '', 'lev|bulgaria', 'Bulgaria'],
  ['BHD', 'Bahraini Dinar', 'BHD', 3, 'Bahraini Dinar', 'dinar|bahrain|manama|دینار', 'Bahrain'],
  ['BIF', 'Burundian Franc', 'FBu', 0, '', 'franc|burundi', 'Burundi'],
  ['BMD', 'Bermudian Dollar', '$', 2, '', 'dollar|bermuda', 'Bermuda'],
  ['BND', 'Brunei Dollar', '$', 2, '', 'dollar|brunei', 'Brunei'],
  ['BOB', 'Bolivian Boliviano', 'Bs', 2, '', 'boliviano|bolivia', 'Bolivia'],
  ['BRL', 'Brazilian Real', 'R$', 2, '', 'real|brazil', 'Brazil'],
  ['BSD', 'Bahamian Dollar', '$', 2, '', 'dollar|bahamas', 'Bahamas'],
  ['BTN', 'Bhutanese Ngultrum', 'Nu.', 2, '', 'ngultrum|bhutan', 'Bhutan'],
  ['BWP', 'Botswana Pula', 'P', 2, '', 'pula|botswana', 'Botswana'],
  ['BYN', 'Belarusian Ruble', 'Br', 2, '', 'ruble|rouble|belarus', 'Belarus'],
  ['BZD', 'Belize Dollar', '$', 2, '', 'dollar|belize', 'Belize'],
  ['CAD', 'Canadian Dollar', 'C$', 2, 'Canadian Dollar', 'dollar|canada|canadian|ڈالر', 'Canada'],
  ['CDF', 'Congolese Franc', 'FC', 2, '', 'franc|congo', 'DR Congo'],
  ['CHF', 'Swiss Franc', 'CHF', 2, 'Swiss Franc', 'franc|switzerland|swiss|zurich|فرانک', 'Switzerland|Liechtenstein'],
  ['CLP', 'Chilean Peso', '$', 0, '', 'peso|chile', 'Chile'],
  ['CNY', 'Chinese Yuan', '¥', 2, 'Cheeni Yuan', 'yuan|renminbi|rmb|china|chinese|یوان', 'China'],
  ['COP', 'Colombian Peso', '$', 2, '', 'peso|colombia', 'Colombia'],
  ['CRC', 'Costa Rican Colon', '₡', 2, '', 'colon|costa rica', 'Costa Rica'],
  ['CUP', 'Cuban Peso', '$', 2, '', 'peso|cuba', 'Cuba'],
  ['CVE', 'Cape Verdean Escudo', '$', 2, '', 'escudo|cape verde|cabo verde', 'Cabo Verde'],
  ['CZK', 'Czech Koruna', 'Kč', 2, '', 'koruna|crown|czech|prague', 'Czechia'],
  ['DJF', 'Djiboutian Franc', 'Fdj', 0, '', 'franc|djibouti', 'Djibouti'],
  ['DKK', 'Danish Krone', 'kr', 2, '', 'krone|crown|denmark', 'Denmark|Greenland|Faroe Islands'],
  ['DOP', 'Dominican Peso', 'RD$', 2, '', 'peso|dominican', 'Dominican Republic'],
  ['DZD', 'Algerian Dinar', 'DA', 2, 'Algerian Dinar', 'dinar|algeria|دینار', 'Algeria'],
  ['EGP', 'Egyptian Pound', 'E£', 2, 'Misri Pound', 'pound|egypt|misr|cairo|مصری', 'Egypt'],
  ['ERN', 'Eritrean Nakfa', 'Nfk', 2, '', 'nakfa|eritrea', 'Eritrea'],
  ['ETB', 'Ethiopian Birr', 'Br', 2, '', 'birr|ethiopia', 'Ethiopia'],
  ['EUR', 'Euro', '€', 2, 'Euro', 'euro|europe|eurozone|european|یورو', 'Eurozone|Germany|France|Spain|Italy|Ireland'],
  ['FJD', 'Fijian Dollar', '$', 2, '', 'dollar|fiji', 'Fiji'],
  ['FKP', 'Falkland Islands Pound', '£', 2, '', 'pound|falkland', 'Falkland Islands'],
  ['GBP', 'British Pound', '£', 2, 'Bartanvi Pound', 'pound|sterling|britain|british|uk|england|london|پاؤنڈ', 'United Kingdom'],
  ['GEL', 'Georgian Lari', '₾', 2, '', 'lari|georgia|tbilisi', 'Georgia'],
  ['GHS', 'Ghanaian Cedi', '₵', 2, '', 'cedi|ghana', 'Ghana'],
  ['GIP', 'Gibraltar Pound', '£', 2, '', 'pound|gibraltar', 'Gibraltar'],
  ['GMD', 'Gambian Dalasi', 'D', 2, '', 'dalasi|gambia', 'Gambia'],
  ['GNF', 'Guinean Franc', 'FG', 0, '', 'franc|guinea', 'Guinea'],
  ['GTQ', 'Guatemalan Quetzal', 'Q', 2, '', 'quetzal|guatemala', 'Guatemala'],
  ['GYD', 'Guyanese Dollar', '$', 2, '', 'dollar|guyana', 'Guyana'],
  ['HKD', 'Hong Kong Dollar', 'HK$', 2, 'Hong Kong Dollar', 'dollar|hong kong|hongkong|ڈالر', 'Hong Kong'],
  ['HNL', 'Honduran Lempira', 'L', 2, '', 'lempira|honduras', 'Honduras'],
  ['HTG', 'Haitian Gourde', 'G', 2, '', 'gourde|haiti', 'Haiti'],
  ['HUF', 'Hungarian Forint', 'Ft', 2, '', 'forint|hungary|budapest', 'Hungary'],
  ['IDR', 'Indonesian Rupiah', 'Rp', 2, 'Indonesian Rupiah', 'rupiah|indonesia|jakarta|bali|روپیہ', 'Indonesia'],
  ['ILS', 'Israeli New Shekel', '₪', 2, '', 'shekel|israel', 'Israel'],
  ['INR', 'Indian Rupee', '₹', 2, 'Bharati Rupaya', 'rupee|rupaya|rupiya|india|indian|delhi|mumbai|روپیہ', 'India'],
  ['IQD', 'Iraqi Dinar', 'IQD', 3, 'Iraqi Dinar', 'dinar|iraq|baghdad|دینار', 'Iraq'],
  ['IRR', 'Iranian Rial', '﷼', 2, 'Irani Riyal', 'rial|riyal|iran|tehran|ریال', 'Iran'],
  ['ISK', 'Icelandic Krona', 'kr', 0, '', 'krona|crown|iceland|reykjavik', 'Iceland'],
  ['JMD', 'Jamaican Dollar', 'J$', 2, '', 'dollar|jamaica', 'Jamaica'],
  ['JOD', 'Jordanian Dinar', 'JOD', 3, 'Urduni Dinar', 'dinar|jordan|amman|دینار', 'Jordan'],
  ['JPY', 'Japanese Yen', '¥', 0, 'Japani Yen', 'yen|japan|japanese|tokyo|ین', 'Japan'],
  ['KES', 'Kenyan Shilling', 'KSh', 2, 'Kenyan Shilling', 'shilling|kenya|nairobi|شلنگ', 'Kenya'],
  ['KGS', 'Kyrgyzstani Som', 'с', 2, '', 'som|kyrgyzstan|bishkek', 'Kyrgyzstan'],
  ['KHR', 'Cambodian Riel', '៛', 2, '', 'riel|cambodia', 'Cambodia'],
  ['KMF', 'Comorian Franc', 'CF', 0, '', 'franc|comoros', 'Comoros'],
  ['KPW', 'North Korean Won', '₩', 2, '', 'won|north korea', 'North Korea'],
  ['KRW', 'South Korean Won', '₩', 0, 'Korean Won', 'won|korea|south korea|seoul|ون', 'South Korea'],
  ['KWD', 'Kuwaiti Dinar', 'KWD', 3, 'Kuwaiti Dinar', 'dinar|kuwait|دینار', 'Kuwait'],
  ['KYD', 'Cayman Islands Dollar', '$', 2, '', 'dollar|cayman', 'Cayman Islands'],
  ['KZT', 'Kazakhstani Tenge', '₸', 2, '', 'tenge|kazakhstan|almaty', 'Kazakhstan'],
  ['LAK', 'Lao Kip', '₭', 2, '', 'kip|laos', 'Laos'],
  ['LBP', 'Lebanese Pound', 'L£', 2, 'Lebnani Pound', 'pound|lira|lebanon|beirut|لیرہ', 'Lebanon'],
  ['LKR', 'Sri Lankan Rupee', 'Rs', 2, 'Sri Lankan Rupaya', 'rupee|rupaya|sri lanka|srilanka|ceylon|colombo|روپیہ', 'Sri Lanka'],
  ['LRD', 'Liberian Dollar', '$', 2, '', 'dollar|liberia', 'Liberia'],
  ['LSL', 'Lesotho Loti', 'L', 2, '', 'loti|lesotho', 'Lesotho'],
  ['LYD', 'Libyan Dinar', 'LYD', 3, 'Libyan Dinar', 'dinar|libya|tripoli|دینار', 'Libya'],
  ['MAD', 'Moroccan Dirham', 'MAD', 2, 'Maghribi Dirham', 'dirham|morocco|casablanca|درہم', 'Morocco'],
  ['MDL', 'Moldovan Leu', 'L', 2, '', 'leu|moldova', 'Moldova'],
  ['MGA', 'Malagasy Ariary', 'Ar', 2, '', 'ariary|madagascar', 'Madagascar'],
  ['MKD', 'Macedonian Denar', 'ден', 2, '', 'denar|macedonia', 'North Macedonia'],
  ['MMK', 'Myanmar Kyat', 'K', 2, '', 'kyat|myanmar|burma', 'Myanmar'],
  ['MNT', 'Mongolian Tugrik', '₮', 2, '', 'tugrik|tugrug|mongolia', 'Mongolia'],
  ['MOP', 'Macanese Pataca', 'MOP$', 2, '', 'pataca|macau|macao', 'Macao'],
  ['MRU', 'Mauritanian Ouguiya', 'UM', 2, '', 'ouguiya|mauritania', 'Mauritania'],
  ['MUR', 'Mauritian Rupee', '₨', 2, 'Mauritius Rupaya', 'rupee|rupaya|mauritius|روپیہ', 'Mauritius'],
  ['MVR', 'Maldivian Rufiyaa', 'Rf', 2, 'Maldives Rufiyaa', 'rufiyaa|maldives|male|روپیہ', 'Maldives'],
  ['MWK', 'Malawian Kwacha', 'MK', 2, '', 'kwacha|malawi', 'Malawi'],
  ['MXN', 'Mexican Peso', 'MX$', 2, 'Mexican Peso', 'peso|mexico|mexican', 'Mexico'],
  ['MYR', 'Malaysian Ringgit', 'RM', 2, 'Malaysian Ringgit', 'ringgit|malaysia|kuala lumpur|رنگٹ', 'Malaysia'],
  ['MZN', 'Mozambican Metical', 'MT', 2, '', 'metical|mozambique', 'Mozambique'],
  ['NAD', 'Namibian Dollar', '$', 2, '', 'dollar|namibia', 'Namibia'],
  ['NGN', 'Nigerian Naira', '₦', 2, 'Nigerian Naira', 'naira|nigeria|lagos|نائرہ', 'Nigeria'],
  ['NIO', 'Nicaraguan Cordoba', 'C$', 2, '', 'cordoba|nicaragua', 'Nicaragua'],
  ['NOK', 'Norwegian Krone', 'kr', 2, '', 'krone|crown|norway|oslo', 'Norway'],
  ['NPR', 'Nepalese Rupee', '₨', 2, 'Nepali Rupaya', 'rupee|rupaya|nepal|kathmandu|روپیہ', 'Nepal'],
  ['NZD', 'New Zealand Dollar', 'NZ$', 2, 'New Zealand Dollar', 'dollar|new zealand|kiwi|ڈالر', 'New Zealand'],
  ['OMR', 'Omani Rial', 'OMR', 3, 'Omani Riyal', 'rial|riyal|oman|muscat|salalah|ریال', 'Oman'],
  ['PAB', 'Panamanian Balboa', 'B/.', 2, '', 'balboa|panama', 'Panama'],
  ['PEN', 'Peruvian Sol', 'S/', 2, '', 'sol|peru', 'Peru'],
  ['PGK', 'Papua New Guinean Kina', 'K', 2, '', 'kina|papua', 'Papua New Guinea'],
  ['PHP', 'Philippine Peso', '₱', 2, 'Philippine Peso', 'peso|piso|philippines|filipino|manila|پیسو', 'Philippines'],
  ['PKR', 'Pakistani Rupee', '₨', 2, 'Pakistani Rupaya', 'rupee|rupaya|rupiya|pakistan|karachi|lahore|روپیہ', 'Pakistan'],
  ['PLN', 'Polish Zloty', 'zł', 2, '', 'zloty|poland|warsaw', 'Poland'],
  ['PYG', 'Paraguayan Guarani', '₲', 0, '', 'guarani|paraguay', 'Paraguay'],
  ['QAR', 'Qatari Riyal', 'QAR', 2, 'Qatari Riyal', 'riyal|rial|qatar|doha|ریال', 'Qatar'],
  ['RON', 'Romanian Leu', 'lei', 2, '', 'leu|romania|bucharest', 'Romania'],
  ['RSD', 'Serbian Dinar', 'дин', 2, '', 'dinar|serbia|belgrade', 'Serbia'],
  ['RUB', 'Russian Ruble', '₽', 2, 'Russi Ruble', 'ruble|rouble|russia|moscow', 'Russia'],
  ['RWF', 'Rwandan Franc', 'FRw', 0, '', 'franc|rwanda', 'Rwanda'],
  ['SAR', 'Saudi Riyal', 'SAR', 2, 'Saudi Riyal', 'riyal|rial|saudi|arabia|jeddah|riyadh|makkah|ریال', 'Saudi Arabia'],
  ['SBD', 'Solomon Islands Dollar', '$', 2, '', 'dollar|solomon', 'Solomon Islands'],
  ['SCR', 'Seychellois Rupee', '₨', 2, 'Seychelles Rupaya', 'rupee|rupaya|seychelles|روپیہ', 'Seychelles'],
  ['SDG', 'Sudanese Pound', 'SDG', 2, '', 'pound|sudan|khartoum', 'Sudan'],
  ['SEK', 'Swedish Krona', 'kr', 2, '', 'krona|crown|sweden|stockholm', 'Sweden'],
  ['SGD', 'Singapore Dollar', 'S$', 2, 'Singapore Dollar', 'dollar|singapore|ڈالر', 'Singapore'],
  ['SHP', 'Saint Helena Pound', '£', 2, '', 'pound|saint helena', 'Saint Helena'],
  ['SLE', 'Sierra Leonean Leone', 'Le', 2, '', 'leone|sierra leone', 'Sierra Leone'],
  ['SOS', 'Somali Shilling', 'Sh', 2, '', 'shilling|somalia|mogadishu', 'Somalia'],
  ['SRD', 'Surinamese Dollar', '$', 2, '', 'dollar|suriname', 'Suriname'],
  ['SSP', 'South Sudanese Pound', '£', 2, '', 'pound|south sudan|juba', 'South Sudan'],
  ['STN', 'Sao Tome and Principe Dobra', 'Db', 2, '', 'dobra|sao tome', 'São Tomé and Príncipe'],
  ['SVC', 'Salvadoran Colon', '₡', 2, '', 'colon|el salvador', 'El Salvador'],
  ['SYP', 'Syrian Pound', 'L£', 2, 'Shami Pound', 'pound|lira|syria|damascus|لیرہ', 'Syria'],
  ['SZL', 'Eswatini Lilangeni', 'L', 2, '', 'lilangeni|eswatini|swaziland', 'Eswatini'],
  ['THB', 'Thai Baht', '฿', 2, 'Thai Baht', 'baht|thailand|bangkok|thai', 'Thailand'],
  ['TJS', 'Tajikistani Somoni', 'SM', 2, '', 'somoni|tajikistan|dushanbe', 'Tajikistan'],
  ['TMT', 'Turkmenistani Manat', 'm', 2, '', 'manat|turkmenistan', 'Turkmenistan'],
  ['TND', 'Tunisian Dinar', 'TND', 3, 'Tunisian Dinar', 'dinar|tunisia|tunis|دینار', 'Tunisia'],
  ['TOP', 'Tongan Paanga', 'T$', 2, '', 'paanga|tonga', 'Tonga'],
  ['TRY', 'Turkish Lira', '₺', 2, 'Turki Lira', 'lira|turkey|turkiye|turkish|istanbul|لیرہ', 'Türkiye'],
  ['TTD', 'Trinidad and Tobago Dollar', 'TT$', 2, '', 'dollar|trinidad|tobago', 'Trinidad and Tobago'],
  ['TWD', 'New Taiwan Dollar', 'NT$', 2, 'Taiwan Dollar', 'dollar|taiwan|taipei|ڈالر', 'Taiwan'],
  ['TZS', 'Tanzanian Shilling', 'TSh', 2, '', 'shilling|tanzania|dar es salaam', 'Tanzania'],
  ['UAH', 'Ukrainian Hryvnia', '₴', 2, '', 'hryvnia|ukraine|kyiv', 'Ukraine'],
  ['UGX', 'Ugandan Shilling', 'USh', 0, '', 'shilling|uganda|kampala', 'Uganda'],
  ['USD', 'US Dollar', '$', 2, 'Amreeki Dollar', 'dollar|us dollar|usd|america|american|united states|usa|buck|ڈالر', 'United States'],
  ['UYU', 'Uruguayan Peso', '$U', 2, '', 'peso|uruguay', 'Uruguay'],
  ['UZS', 'Uzbekistani Som', 'soʼm', 2, '', 'som|sum|uzbekistan|tashkent', 'Uzbekistan'],
  ['VED', 'Venezuelan Bolivar Digital', 'Bs', 2, '', 'bolivar|venezuela', 'Venezuela'],
  ['VES', 'Venezuelan Bolivar Soberano', 'Bs.S', 2, '', 'bolivar|venezuela', 'Venezuela'],
  ['VND', 'Vietnamese Dong', '₫', 0, '', 'dong|vietnam|hanoi|saigon', 'Vietnam'],
  ['VUV', 'Vanuatu Vatu', 'VT', 0, '', 'vatu|vanuatu', 'Vanuatu'],
  ['WST', 'Samoan Tala', 'T', 2, '', 'tala|samoa', 'Samoa'],
  ['XAF', 'Central African CFA Franc', 'FCFA', 0, '', 'franc|cfa|central africa|cameroon|gabon|chad', 'Cameroon|Gabon|Chad|Congo|Central African Republic|Equatorial Guinea'],
  ['XCD', 'East Caribbean Dollar', 'EC$', 2, '', 'dollar|east caribbean|antigua|grenada|saint lucia', 'Antigua and Barbuda|Grenada|Saint Lucia|Dominica'],
  ['XCG', 'Caribbean Guilder', 'Cg', 2, '', 'guilder|caribbean|curacao|sint maarten', 'Curaçao|Sint Maarten'],
  ['XOF', 'West African CFA Franc', 'CFA', 0, '', 'franc|cfa|west africa|senegal|ivory coast|mali', 'Senegal|Côte d’Ivoire|Mali|Burkina Faso|Benin|Niger|Togo|Guinea-Bissau'],
  ['XPF', 'CFP Franc', '₣', 0, '', 'franc|cfp|pacific|tahiti|new caledonia', 'French Polynesia|New Caledonia|Wallis and Futuna'],
  ['YER', 'Yemeni Rial', '﷼', 2, 'Yemeni Riyal', 'rial|riyal|yemen|sanaa|ریال', 'Yemen'],
  ['ZAR', 'South African Rand', 'R', 2, 'South African Rand', 'rand|south africa|johannesburg|رینڈ', 'South Africa'],
  ['ZMW', 'Zambian Kwacha', 'ZK', 2, '', 'kwacha|zambia|lusaka', 'Zambia'],
  ['ZWG', 'Zimbabwe Gold', 'ZiG', 2, '', 'zig|zimbabwe|gold', 'Zimbabwe'],
];

const split = (raw: string): string[] => (raw ? raw.split('|').filter(Boolean) : []);

/** Every active ISO 4217 currency the app knows about, A–Z by code. */
export const CURRENCIES: readonly CurrencyMeta[] = RAW.map(
  ([code, en, symbol, minorUnits, ur, aliases, regions]): CurrencyMeta => ({
    code,
    name: { en, ur: ur || en },
    symbol,
    minorUnits,
    aliases: split(aliases),
    regions: split(regions),
  }),
).sort((a, b) => a.code.localeCompare(b.code));

export const CURRENCY_CODES: readonly string[] = CURRENCIES.map((c) => c.code);

const BY_CODE: ReadonlyMap<string, CurrencyMeta> = new Map(CURRENCIES.map((c) => [c.code, c]));

/** Metadata for an ISO code (case-insensitive), or undefined if unknown. */
export function currencyMeta(code: string): CurrencyMeta | undefined {
  if (typeof code !== 'string') return undefined;
  return BY_CODE.get(code.trim().toUpperCase());
}

/** Is this an active ISO 4217 code the app knows about? */
export function isSupportedCurrency(code: string): boolean {
  return currencyMeta(code) !== undefined;
}

/**
 * Decimal places for a currency. Unknown codes fall back to 2 — the safe
 * default: over-precision never loses money, under-precision does.
 */
export function currencyMinorUnits(code: string): number {
  return currencyMeta(code)?.minorUnits ?? 2;
}

/**
 * Round a money amount to its currency's smallest unit.
 *
 * The app-wide `Math.round(x * 100) / 100` idiom is the 2-decimal special case
 * of this. Use this wherever a currency is in scope so a JPY figure never
 * grows phantom cents and a KWD figure never loses a fils.
 */
export function roundMoney(amount: number, code?: string): number {
  if (!Number.isFinite(amount)) return amount;
  const factor = 10 ** (code == null ? 2 : currencyMinorUnits(code));
  return Math.round(amount * factor) / factor;
}

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * Case- and diacritic-insensitive key. NFD-decomposes then strips Latin
 * combining marks and Arabic/Urdu harakat, so "Türkiye" matches "turkiye" and
 * "رِیال" matches "ریال".
 */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ًͯ-ْٰ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * The regional fallback order for Hisaab's actual audience: Pakistan first,
 * then the Gulf where most of the diaspora earns, then the Western remittance
 * corridors, then the wider expat/labour corridors. This is the list a brand
 * new user with no history sees.
 */
const DEFAULT_REGIONAL_ORDER: readonly string[] = [
  'PKR', 'AED', 'SAR', 'USD', 'GBP',
  'QAR', 'OMR', 'KWD', 'BHD', 'INR',
  'EUR', 'CAD', 'AUD', 'MYR', 'PHP',
  'BDT', 'TRY', 'SGD', 'HKD', 'LKR',
];

/**
 * Tie-break bias toward the currencies this app's audience actually holds.
 *
 * Ranking tiers are decided first; this only orders currencies that tied. It
 * is what makes "dirham" surface AED before MAD, "rupaya" surface PKR before
 * INR, and "riyal" surface SAR before IRR — instead of blind alphabetical
 * order handing the top row to whoever happens to sort first.
 */
function audienceRank(code: string): number {
  const index = DEFAULT_REGIONAL_ORDER.indexOf(code);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

interface SearchEntry {
  meta: CurrencyMeta;
  code: string;
  /** Every searchable term: names, aliases, region names. */
  terms: string[];
}

const SEARCH_INDEX: readonly SearchEntry[] = CURRENCIES.map((meta) => ({
  meta,
  code: meta.code.toLowerCase(),
  terms: Array.from(
    new Set(
      [meta.name.en, meta.name.ur, ...meta.aliases, ...meta.regions].map(normalize).filter(Boolean),
    ),
  ),
}));

/**
 * Ranked currency search.
 *
 * Ranking (lower wins): exact code > code prefix > name/alias prefix >
 * substring anywhere. `lang` decides which display name is preferred when two
 * currencies tie — the reader's own language sorts first. Ties break A–Z by
 * code so the list is stable.
 *
 * An empty (or whitespace-only) query returns [] — the picker shows its
 * `topCurrencies` row instead of dumping 160 rows.
 */
export function searchCurrencies(query: string, lang: 'ur' | 'en'): CurrencyMeta[] {
  const q = normalize(query ?? '');
  if (!q) return [];

  const hits: { meta: CurrencyMeta; rank: number; langBoost: number }[] = [];

  for (const entry of SEARCH_INDEX) {
    let rank = Number.POSITIVE_INFINITY;

    if (entry.code === q) rank = 0;
    else if (entry.code.startsWith(q)) rank = 1;
    else {
      for (const term of entry.terms) {
        if (term.startsWith(q)) {
          rank = Math.min(rank, 2);
          break;
        }
      }
      if (rank === Number.POSITIVE_INFINITY) {
        // Substring anywhere — code included ("ind" → INR via the name, "kw"
        // via the code prefix already, "eur" mid-word in a region name).
        const inCode = entry.code.includes(q);
        const inTerm = entry.terms.some((term) => term.includes(q));
        if (inCode || inTerm) rank = 3;
      }
    }

    if (rank === Number.POSITIVE_INFINITY) continue;

    // Prefer a match on the reader's own language when ranks tie.
    const preferred = normalize(lang === 'ur' ? entry.meta.name.ur : entry.meta.name.en);
    const langBoost = preferred.startsWith(q) ? 0 : preferred.includes(q) ? 1 : 2;

    hits.push({ meta: entry.meta, rank, langBoost });
  }

  return hits
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.langBoost - b.langBoost ||
        audienceRank(a.meta.code) - audienceRank(b.meta.code) ||
        a.meta.code.localeCompare(b.meta.code),
    )
    .map((h) => h.meta);
}

// ── Top / suggested currencies ───────────────────────────────────────────────

/**
 * Region-specific head of the list. Keyed by ISO 3166 alpha-2 (upper-cased by
 * the lookup) — a user in Saudi should not have to scroll past PKR to find
 * SAR. Anything not listed here falls straight through to
 * DEFAULT_REGIONAL_ORDER.
 */
const REGION_HEAD: Readonly<Record<string, readonly string[]>> = {
  PK: ['PKR', 'AED', 'SAR', 'USD', 'GBP'],
  AE: ['AED', 'PKR', 'INR', 'USD', 'SAR'],
  SA: ['SAR', 'PKR', 'INR', 'USD', 'AED'],
  QA: ['QAR', 'PKR', 'INR', 'USD', 'AED'],
  OM: ['OMR', 'PKR', 'INR', 'AED', 'USD'],
  KW: ['KWD', 'PKR', 'INR', 'USD', 'AED'],
  BH: ['BHD', 'PKR', 'INR', 'USD', 'AED'],
  GB: ['GBP', 'PKR', 'EUR', 'USD', 'AED'],
  US: ['USD', 'PKR', 'INR', 'AED', 'CAD'],
  CA: ['CAD', 'PKR', 'USD', 'INR', 'AED'],
  AU: ['AUD', 'PKR', 'USD', 'INR', 'AED'],
  MY: ['MYR', 'PKR', 'USD', 'SGD', 'AED'],
  IN: ['INR', 'AED', 'USD', 'SAR', 'GBP'],
  PH: ['PHP', 'AED', 'USD', 'SAR', 'QAR'],
  SG: ['SGD', 'MYR', 'USD', 'PKR', 'INR'],
  BD: ['BDT', 'SAR', 'AED', 'USD', 'MYR'],
};

export interface TopCurrenciesInput {
  /** The user's primary currency — always first when known. */
  primary?: string;
  /** Codes the user has actually used, most-recent first. */
  used?: string[];
  /** ISO 3166 alpha-2 country hint (case-insensitive). */
  region?: string;
  /** Default 5. */
  limit?: number;
}

/**
 * The personal "top N" row above the A–Z list: the user's primary currency,
 * then what they've recently used, then sensible regional defaults — deduped,
 * unknown codes dropped, capped at `limit`.
 */
export function topCurrencies(input: TopCurrenciesInput): CurrencyMeta[] {
  const limit = Math.max(0, input.limit ?? 5);
  if (limit === 0) return [];

  const regionKey = input.region?.trim().toUpperCase() ?? '';
  const ordered = [
    ...(input.primary ? [input.primary] : []),
    ...(input.used ?? []),
    ...(REGION_HEAD[regionKey] ?? []),
    ...DEFAULT_REGIONAL_ORDER,
  ];

  const out: CurrencyMeta[] = [];
  const seen = new Set<string>();
  for (const raw of ordered) {
    const meta = currencyMeta(raw);
    if (!meta || seen.has(meta.code)) continue;
    seen.add(meta.code);
    out.push(meta);
    if (out.length === limit) break;
  }
  return out;
}
