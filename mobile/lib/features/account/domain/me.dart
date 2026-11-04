import 'package:equatable/equatable.dart';

/// The signed-in investor (schema Me). `kyc` is one neutral word: "review"
/// covers every review state and never carries a reason (tipping-off rules).
class Me extends Equatable {
  const Me({
    required this.displayName,
    required this.kyc,
    required this.wallet,
    required this.nonResident,
    required this.document,
    required this.supportReference,
  });

  factory Me.fromJson(Map<String, dynamic> j) {
    final r = j['residency'] as Map<String, dynamic>;
    return Me(
      displayName: j['display_name'] as String,
      kyc: j['kyc'] as String,
      wallet: j['wallet'] as String,
      nonResident: r['status'] == 'non_resident',
      document: r['document'] as String,
      supportReference: j['support_reference'] as String?,
    );
  }

  final String displayName;
  final String kyc;
  final String wallet;
  final bool nonResident;
  final String document;
  final String? supportReference;

  @override
  List<Object?> get props => [displayName, kyc, wallet, nonResident, document, supportReference];
}

abstract interface class AccountRepository {
  Future<Me> me();
}
