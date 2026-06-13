const { z } = require('zod');

const validStatuses = [
  'ACCEPTED', 'ALLOTTED', 'ARRIVED', 'DISPATCHED', 
  'ARRIVED_CUSTOMER_DOORSTEP', 'DELIVERED', 'CANCELLED', 
  'CANCELLED_BY_CUSTOMER', 'RETURNED_TO_SELLER', 'UNDELIVERED',
  'COLLECTED', 'CUSTOMER_DO_STEP', 'CUSTOMER_DOOR_STEP', 'RTS_INITIATED', 'RTS_COMPLETED'
];

const statusCallbackSchema = z.object({
  coid: z.string().optional(),
  client_order_id: z.string().optional(),
  sfx_order_id: z.number().or(z.string()).optional().transform(val => val ? BigInt(val) : undefined),
  status: z.string(),
  rider_latitude: z.number().optional(),
  rider_longitude: z.number().optional(),
  pickup_eta: z.number().optional(),
  drop_eta: z.number().optional(),
}).strip();

const locationCallbackSchema = z.object({
  coid: z.string().optional(),
  client_order_id: z.string().optional(),
  sfx_order_id: z.number().or(z.string()).optional().transform(val => val ? BigInt(val) : undefined),
  rider_latitude: z.number().min(-90).max(90),
  rider_longitude: z.number().min(-180).max(180),
  pickup_eta: z.number().optional(),
  drop_eta: z.number().optional(),
}).strip();

function validateStatusCallback(payload) {
  return statusCallbackSchema.parse(payload);
}

function validateLocationCallback(payload) {
  return locationCallbackSchema.parse(payload);
}

module.exports = {
  validateStatusCallback,
  validateLocationCallback
};

