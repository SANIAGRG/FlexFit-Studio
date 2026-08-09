/**
 * Members may cancel free of charge up to this many hours before the class
 * starts. Cancelling later still frees the spot but forfeits the credit.
 */
export const FREE_CANCELLATION_HOURS = 12;

/**
 * Corporate members may cancel free of charge up to this many hours before
 * the class starts — double the individual window. Intentionally different:
 * corporate cancellations affect a shared company credit pool other
 * employees are drawing from, not just the cancelling member, so the policy
 * gives more notice before the pool loses the credit back.
 */
export const CORPORATE_FREE_CANCELLATION_HOURS = 24;

/**
 * Members may reschedule free of charge up to this many hours before the
 * original class starts. Intentionally smaller than either cancellation
 * window — rescheduling doesn't free a credit back into general circulation
 * (it moves the same booking to a different class), so it's a lower-risk
 * action the policy affords more flexibility to.
 */
export const FREE_RESCHEDULE_HOURS = 4;

/**
 * Plans with `creditsRemaining >= UNLIMITED_CREDITS` are treated as
 * unlimited: booking never decrements, cancelling never increments back.
 */
export const UNLIMITED_CREDITS = 999;
