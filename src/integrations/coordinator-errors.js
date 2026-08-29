export class IntegrationCoordinatorError extends Error {
  constructor(message, {
    status = 400,
    code = "integration_coordinator_error"
  } = {}) {
    super(message);
    this.name = "IntegrationCoordinatorError";
    this.status = status;
    this.code = code;
  }
}

export class IntegrationEffectDeliveryError extends Error {
  constructor(message, {
    retryable = false,
    code = "integration_effect_delivery_failed",
    metadata = {},
    cause
  } = {}) {
    super(message, { cause });
    this.name = "IntegrationEffectDeliveryError";
    this.retryable = retryable;
    this.code = code;
    this.metadata = metadata;
  }
}
