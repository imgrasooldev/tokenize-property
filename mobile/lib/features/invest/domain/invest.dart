import 'package:equatable/equatable.dart';

/// A reservation the app asked for; the investor confirms it on the website
/// (schema SubscriptionRequest of docs/api/openapi.json, ADR 0018 amendment 1).
class SubscriptionRequest extends Equatable {
  const SubscriptionRequest({
    required this.id,
    required this.offeringId,
    required this.units,
    required this.amountPaisa,
    required this.status,
    required this.code,
    required this.confirmUri,
    required this.confirmUriComplete,
    required this.expiresAt,
    required this.subscriptionId,
  });

  factory SubscriptionRequest.fromJson(Map<String, dynamic> j) => SubscriptionRequest(
    id: j['id'] as String,
    offeringId: j['offering_id'] as String,
    units: j['units'] as String,
    amountPaisa: (j['amount'] as Map<String, dynamic>?)?['amount'] as String?,
    status: j['status'] as String,
    code: j['confirmation_code'] as String,
    confirmUri: j['confirmation_uri'] as String,
    confirmUriComplete: j['confirmation_uri_complete'] as String,
    expiresAt: DateTime.parse(j['expires_at'] as String),
    subscriptionId: j['subscription_id'] as String?,
  );

  final String id;
  final String offeringId;
  final String units;
  final String? amountPaisa;

  /// pending, confirmed, declined or expired.
  final String status;
  final String code;
  final String confirmUri;
  final String confirmUriComplete;
  final DateTime expiresAt;
  final String? subscriptionId;

  bool get pending => status == 'pending';

  @override
  List<Object?> get props => [id, status, subscriptionId];
}

/// One subscription with its payment instructions (schema SubscriptionDetail).
class SubscriptionDetail extends Equatable {
  const SubscriptionDetail({
    required this.id,
    required this.units,
    required this.amountPaisa,
    required this.status,
    required this.paymentCode,
    required this.payToAccount,
    required this.payBefore,
  });

  factory SubscriptionDetail.fromJson(Map<String, dynamic> j) {
    final payment = j['payment'] as Map<String, dynamic>?;
    return SubscriptionDetail(
      id: j['id'] as String,
      units: j['units'] as String,
      amountPaisa: (j['amount'] as Map<String, dynamic>)['amount'] as String,
      status: j['status'] as String,
      paymentCode: payment?['code'] as String?,
      payToAccount: payment?['pay_to_account'] as String?,
      payBefore: payment?['expires_at'] == null ? null : DateTime.parse(payment!['expires_at'] as String),
    );
  }

  final String id;
  final String units;
  final String amountPaisa;
  final String status;
  final String? paymentCode;
  final String? payToAccount;
  final DateTime? payBefore;

  @override
  List<Object?> get props => [id, status, paymentCode];
}

abstract interface class InvestRepository {
  /// Asks for a reservation; the same [idempotencyKey] returns the same request.
  Future<SubscriptionRequest> requestReservation({
    required String offeringId,
    required String units,
    required String idempotencyKey,
  });

  Future<SubscriptionRequest> request(String id);

  Future<SubscriptionDetail> subscription(String id);
}
