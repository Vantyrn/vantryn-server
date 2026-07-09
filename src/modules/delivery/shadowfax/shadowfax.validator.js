const { z } = require('zod');

// Coerce sfx_order_id (may arrive as number or string) to BigInt.
const sfxOrderId = z.union([z.number(), z.string()]).optional()
  .transform((val) => (val || val === 0 ? BigInt(val) : undefined));

// Store-based callbacks send `order_status`; older/flash payloads send `status`.
// Keep both raw fields and expose a normalized `status`.
const statusCallbackSchema = z.object({
  coid: z.string().optional(),
  client_order_id: z.string().optional(),
  sfx_order_id: sfxOrderId,
  status: z.string().optional(),
  order_status: z.string().optional(),
  rider_name: z.string().optional(),
  rider_contact: z.union([z.string(), z.number()]).optional(),
  rider_id: z.union([z.string(), z.number()]).optional(),
  sfx_rider_id: z.union([z.string(), z.number()]).optional(),
  rider_latitude: z.number().optional(),
  rider_longitude: z.number().optional(),
  pickup_eta: z.number().optional(),
  drop_eta: z.number().optional(),
  cancel_reason: z.union([z.string(), z.number()]).optional(),
  cancel_reason_text: z.string().optional(),
  track_url: z.string().optional()
}).passthrough().transform((d) => ({ ...d, status: d.status || d.order_status }));

const locationCallbackSchema = z.object({
  coid: z.string().optional(),
  client_order_id: z.string().optional(),
  order_id: z.string().optional(), // store-based location callback uses order_id (= COID)
  sfx_order_id: sfxOrderId,
  rider_name: z.string().optional(),
  rider_id: z.union([z.string(), z.number()]).optional(),
  sfx_rider_id: z.union([z.string(), z.number()]).optional(),
  rider_latitude: z.number().min(-90).max(90),
  rider_longitude: z.number().min(-180).max(180),
  pickup_eta: z.number().optional(),
  drop_eta: z.number().optional()
}).passthrough().transform((d) => ({ ...d, coid: d.coid || d.client_order_id || d.order_id }));

function validateStatusCallback(payload) {
  const parsed = statusCallbackSchema.parse(payload);
  if (!parsed.status) {
    throw new Error('Missing status/order_status');
  }
  return parsed;
}

function validateLocationCallback(payload) {
  return locationCallbackSchema.parse(payload);
}

module.exports = {
  validateStatusCallback,
  validateLocationCallback
};
