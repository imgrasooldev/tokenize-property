import 'package:equatable/equatable.dart';

/// A rent distribution the investor takes part in (schema Distribution).
class RentDistribution extends Equatable {
  const RentDistribution({
    required this.token,
    required this.distributionId,
    required this.period,
    required this.status,
    required this.units,
    required this.grossPaisa,
    required this.withheldPaisa,
    required this.netPaisa,
  });

  factory RentDistribution.fromJson(Map<String, dynamic> j) => RentDistribution(
    token: j['token'] as String,
    distributionId: j['distribution_id'] as String,
    period: j['period'] as String,
    status: j['status'] as String,
    units: j['units'] as String,
    grossPaisa: (j['gross'] as Map<String, dynamic>)['amount'] as String,
    withheldPaisa: (j['withheld'] as Map<String, dynamic>)['amount'] as String,
    netPaisa: (j['net'] as Map<String, dynamic>)['amount'] as String,
  );

  final String token;
  final String distributionId;
  final String period;

  /// published (objection window), finalized, paid.
  final String status;
  final String units;
  final String grossPaisa;
  final String withheldPaisa;
  final String netPaisa;

  @override
  List<Object?> get props => [token, distributionId, status];
}

/// The investor's Merkle proof (schema DistributionProof): the API rebuilt the root on chain from
/// the published statement and checked the statement's hash against the chain.
class RentProof extends Equatable {
  const RentProof({
    required this.registry,
    required this.leaf,
    required this.proof,
    required this.merkleRoot,
    required this.statementMatches,
    required this.netPaisa,
  });

  factory RentProof.fromJson(Map<String, dynamic> j) => RentProof(
    registry: j['registry'] as String,
    leaf: j['leaf'] as String,
    proof: (j['proof'] as List<dynamic>).cast<String>(),
    merkleRoot: j['merkle_root'] as String,
    statementMatches: j['statement_matches'] as bool,
    netPaisa: (j['amount'] as Map<String, dynamic>)['amount'] as String,
  );

  final String registry;
  final String leaf;
  final List<String> proof;
  final String merkleRoot;
  final bool statementMatches;
  final String netPaisa;

  @override
  List<Object?> get props => [leaf, merkleRoot, statementMatches];
}

abstract interface class RentRepository {
  Future<List<RentDistribution>> distributions();
  Future<RentProof> proof(RentDistribution d);
}
