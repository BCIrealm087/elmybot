export class SchedulingUserFacingError extends Error {
  constructor(message, status=500) {
    super (message);
    if (status !== null && status !== undefined)
      this.status = status;
  }
}