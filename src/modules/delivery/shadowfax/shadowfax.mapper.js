/**
 * Shadowfax Data Mapper
 * Transforms data between internal representations and Shadowfax Flash API requirements.
 */

const env = require('../../../config/env');
const logger = require('../../../../lib/logger');

/**
 * Builds the place order payload according to the Shadowfax Flash schema.
 */
function buildPlaceOrderPayload(internalOrder, vendor, customer) {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const coid = `${internalOrder.id}-${dateStr}`;

  // Enforce white-labeled delivery details & default checks
  const isPrepaid = internalOrder.paymentMethod ? internalOrder.paymentMethod.toUpperCase() !== 'COD' : true;
  const cashToCollect = isPrepaid ? 0 : Number(internalOrder.totalAmount);

  return {
    pickup_details: {
      name: vendor.businessName || 'Store Vendor',
      contact_number: vendor.phone ? vendor.phone.replace(/[^0-9]/g, '').slice(-10) : '9999999999',
      address: vendor.storeAddress || 'Store Vendor address',
      latitude: Number(vendor.latitude) || 0,
      longitude: Number(vendor.longitude) || 0
    },
    drop_details: {
      name: customer.fullName || 'Customer',
      contact_number: internalOrder.addressSnapshot?.phone || customer.phone ? (internalOrder.addressSnapshot?.phone || customer.phone).replace(/[^0-9]/g, '').slice(-10) : '9999999999',
      is_contact_number_masked: false,
      address: internalOrder.addressSnapshot?.addressLine1 || 'Customer Delivery Address',
      latitude: Number(internalOrder.addressSnapshot?.latitude) || 0,
      longitude: Number(internalOrder.addressSnapshot?.longitude) || 0
    },
    order_details: {
      order_id: coid, // Must be unique client reference
      is_prepaid: isPrepaid,
      cash_to_be_collected: cashToCollect,
      delivery_charge_to_be_collected_from_customer: false, // handoff handles delivery charge as dynamic bill
      rts_required: true // Return to store if delivery fails
    },
    user_details: {
      contact_number: vendor.phone ? vendor.phone.replace(/[^0-9]/g, '').slice(-10) : '9999999999',
      credits_key: env.SFX_CLIENT_CODE || (env.NODE_ENV === 'production' ? env.SFX_PROD_TOKEN : env.SFX_STAGING_TOKEN)
    },
    validations: {
      pickup: {
        is_otp_required: false
      },
      drop: {
        is_otp_required: true
      }
    },
    communications: {
      send_sms_to_pickup_person: true,
      send_sms_to_drop_person: true,
      send_rts_sms_to_pickup_person: true
    }
  };
}

/**
 * Maps Shadowfax Flash statuses to internal order tracking states.
 */
function mapSfxStatusToInternal(sfxStatus) {
  if (!sfxStatus) return 'PENDING_DELIVERY_UPDATE';
  
  switch (sfxStatus.toUpperCase()) {
    case 'ALLOTTED':
    case 'ACCEPTED':
      return 'RIDER_ASSIGNED';
    case 'ARRIVED':
      return 'RIDER_AT_STORE';
    case 'COLLECTED':
    case 'DISPATCHED':
      return 'picked_up'; // Map to Vantyrn standard lowercase
    case 'CUSTOMER_DOOR_STEP':
    case 'ARRIVED_AT_CUSTOMER_DOORSTEP':
      return 'arrived_at_customer';
    case 'DELIVERED':
      return 'delivered'; // Map to Vantyrn standard lowercase
    case 'CANCELLED':
      return 'cancelled'; // Map to Vantyrn standard lowercase
    case 'RTS_INITIATED':
      return 'RETURN_TO_STORE_IN_PROGRESS';
    case 'RTS_COMPLETED':
      return 'RETURNED_TO_SELLER';
    default:
      console.warn(`[Shadowfax Mapper] Unknown SFX Status: ${sfxStatus}`);
      return 'PENDING_DELIVERY_UPDATE';
  }
}

/**
 * Maps Internal cancel reason to Shadowfax required format.
 */
function mapCancelReasonToSfx(internalReason) {
  const reason = internalReason.length > 128 ? internalReason.substring(0, 125) + '...' : internalReason;
  return {
    reason
  };
}

module.exports = {
  buildPlaceOrderPayload,
  mapSfxStatusToInternal,
  mapCancelReasonToSfx
};
