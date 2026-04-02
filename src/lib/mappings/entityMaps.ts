import {
  DetectEntities,
  MaskingMethod,
  DetectOutputTranscription,
} from "skyflow-node";

/**
 * Type-safe mapping from string entity names to DetectEntities enum values.
 * This ensures proper type checking and prevents runtime errors from invalid entity mappings.
 */
export const ENTITY_MAP: Record<string, DetectEntities> = {
  age: DetectEntities.AGE,
  bank_account: DetectEntities.BANK_ACCOUNT,
  credit_card: DetectEntities.CREDIT_CARD,
  credit_card_expiration: DetectEntities.CREDIT_CARD_EXPIRATION,
  cvv: DetectEntities.CVV,
  date: DetectEntities.DATE,
  date_interval: DetectEntities.DATE_INTERVAL,
  dob: DetectEntities.DOB,
  driver_license: DetectEntities.DRIVER_LICENSE,
  email_address: DetectEntities.EMAIL_ADDRESS,
  healthcare_number: DetectEntities.HEALTHCARE_NUMBER,
  ip_address: DetectEntities.IP_ADDRESS,
  location: DetectEntities.LOCATION,
  name: DetectEntities.NAME,
  numerical_pii: DetectEntities.NUMERICAL_PII,
  phone_number: DetectEntities.PHONE_NUMBER,
  ssn: DetectEntities.SSN,
  url: DetectEntities.URL,
  vehicle_id: DetectEntities.VEHICLE_ID,
  medical_code: DetectEntities.MEDICAL_CODE,
  name_family: DetectEntities.NAME_FAMILY,
  name_given: DetectEntities.NAME_GIVEN,
  account_number: DetectEntities.ACCOUNT_NUMBER,
  event: DetectEntities.EVENT,
  filename: DetectEntities.FILENAME,
  gender: DetectEntities.GENDER,
  language: DetectEntities.LANGUAGE,
  location_address: DetectEntities.LOCATION_ADDRESS,
  location_city: DetectEntities.LOCATION_CITY,
  location_coordinate: DetectEntities.LOCATION_COORDINATE,
  location_country: DetectEntities.LOCATION_COUNTRY,
  location_state: DetectEntities.LOCATION_STATE,
  location_zip: DetectEntities.LOCATION_ZIP,
  marital_status: DetectEntities.MARITAL_STATUS,
  money: DetectEntities.MONEY,
  name_medical_professional: DetectEntities.NAME_MEDICAL_PROFESSIONAL,
  occupation: DetectEntities.OCCUPATION,
  organization: DetectEntities.ORGANIZATION,
  organization_medical_facility: DetectEntities.ORGANIZATION_MEDICAL_FACILITY,
  origin: DetectEntities.ORIGIN,
  passport_number: DetectEntities.PASSPORT_NUMBER,
  password: DetectEntities.PASSWORD,
  physical_attribute: DetectEntities.PHYSICAL_ATTRIBUTE,
  political_affiliation: DetectEntities.POLITICAL_AFFILIATION,
  religion: DetectEntities.RELIGION,
  time: DetectEntities.TIME,
  username: DetectEntities.USERNAME,
  zodiac_sign: DetectEntities.ZODIAC_SIGN,
  blood_type: DetectEntities.BLOOD_TYPE,
  condition: DetectEntities.CONDITION,
  dose: DetectEntities.DOSE,
  drug: DetectEntities.DRUG,
  injury: DetectEntities.INJURY,
  medical_process: DetectEntities.MEDICAL_PROCESS,
  statistics: DetectEntities.STATISTICS,
  routing_number: DetectEntities.ROUTING_NUMBER,
  corporate_action: DetectEntities.CORPORATE_ACTION,
  financial_metric: DetectEntities.FINANCIAL_METRIC,
  product: DetectEntities.PRODUCT,
  trend: DetectEntities.TREND,
  duration: DetectEntities.DURATION,
  location_address_street: DetectEntities.LOCATION_ADDRESS_STREET,
  all: DetectEntities.ALL,
  sexuality: DetectEntities.SEXUALITY,
  effect: DetectEntities.EFFECT,
  project: DetectEntities.PROJECT,
  organization_id: DetectEntities.ORGANIZATION_ID,
  day: DetectEntities.DAY,
  month: DetectEntities.MONTH,
  // Note: 'year' entity is not available in the current skyflow-node version
};

/**
 * Type-safe mapping from string masking method names to MaskingMethod enum values.
 */
export const MASKING_METHOD_MAP: Record<string, MaskingMethod> = {
  BLACKBOX: MaskingMethod.Blackbox,
  // Note: 'PIXELATE' is not available in the current skyflow-node version
  BLUR: MaskingMethod.Blur,
  // Note: 'REDACT' is not available in the current skyflow-node version
};

/**
 * Type-safe mapping from string transcription names to DetectOutputTranscription enum values.
 */
export const TRANSCRIPTION_MAP: Record<string, DetectOutputTranscription> = {
  PLAINTEXT_TRANSCRIPTION: DetectOutputTranscription.PLAINTEXT_TRANSCRIPTION,
  DIARIZED_TRANSCRIPTION: DetectOutputTranscription.DIARIZED_TRANSCRIPTION,
};

/**
 * Tuple of all valid entity type strings, derived from ENTITY_MAP.
 * Use this with z.enum() in tool schemas to keep the list in sync automatically.
 */
export const ENTITY_KEYS = Object.keys(ENTITY_MAP) as [string, ...string[]];

/**
 * Check if an entity type is valid
 */
export function isValidEntity(entity: string): boolean {
  return entity in ENTITY_MAP;
}

/**
 * Get the DetectEntities enum value for a string entity name
 * @throws Error if the entity type is invalid
 */
export function getEntityEnum(entity: string): DetectEntities {
  if (!(entity in ENTITY_MAP)) {
    throw new Error(`Invalid entity type: ${entity}`);
  }
  return ENTITY_MAP[entity];
}

/**
 * Get the MaskingMethod enum value for a string masking method name
 * @throws Error if the masking method is invalid
 */
export function getMaskingMethodEnum(method: string): MaskingMethod {
  const maskingEnum = MASKING_METHOD_MAP[method];
  if (!maskingEnum) {
    throw new Error(`Invalid masking method: ${method}`);
  }
  return maskingEnum;
}

/**
 * Get the DetectOutputTranscription enum value for a string transcription type
 * @throws Error if the transcription type is invalid
 */
export function getTranscriptionEnum(
  transcription: string
): DetectOutputTranscription {
  const transcriptionEnum = TRANSCRIPTION_MAP[transcription];
  if (!transcriptionEnum) {
    throw new Error(`Invalid transcription type: ${transcription}`);
  }
  return transcriptionEnum;
}
