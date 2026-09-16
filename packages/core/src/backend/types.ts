export type OrderStatus =
  'pending' | 'partially_shipped' | 'shipped' | 'partially_delivered' | 'delivered' | 'returned';

export type ShipmentStatus =
  'pending' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'returned';

export type Currency = 'USD' | 'EUR';

export type OrderItem = {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPriceMinorUnits: number;
};

export type OrderShipment = {
  id: string;
  carrier: string;
  carrierStatus: string;
  status: ShipmentStatus;
  trackingNumber: string | null;
  items: {
    orderItemId: string;
    quantity: number;
  }[];
};

export type Order = {
  id: string;
  createdAt: number;
  updatedAt: number;
  email: string;
  status: OrderStatus;
  items: OrderItem[];
  // calculated from items[], never persisted
  totalMinorUnits: number;
  currency: Currency;
  shipments: OrderShipment[];
};

export type SanitizedOrder = Pick<
  Order,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'status'
  | 'currency'
  | 'totalMinorUnits'
  | 'items'
  | 'shipments'
>;

/** The request the key names. Two requests are the same when these agree. */
export type IssueRefundParams = {
  orderId: string;
  orderItemId: string;
  quantity: number;
};

export type RefundErrorType =
  | 'order_not_found'
  | 'line_not_found'
  | 'quantity_exceeds_unrefunded'
  | 'not_refundable'
  | 'quantity_invalid'
  | 'key_conflict'
  | '_OTHER';

/**
 * Why a backend could not know the outcome. Annotation for the trace and
 * the inbox only: nothing decides on it, position decides (see the tool's
 * zones). `in_flight` is a replay of a request the backend is still
 * executing.
 */
export type UnknownRefundErrorType = 'in_flight' | 'platform_unreachable' | 'lookup_failed';

export type IssueRefundResponse =
  | {
      status: 'ok';
      refundId: string;
      amountMinorUnits: number;
      currency: Currency;
    }
  | {
      status: 'failed';
      errorType: RefundErrorType;
      error?: unknown;
    }
  | {
      status: 'unknown';
      errorType?: UnknownRefundErrorType;
    };
