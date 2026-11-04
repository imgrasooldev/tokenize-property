import 'package:equatable/equatable.dart';

class Holding extends Equatable {
  const Holding({required this.token, required this.units, required this.frozenUnits});

  factory Holding.fromJson(Map<String, dynamic> j) =>
      Holding(token: j['token'] as String, units: j['units'] as String, frozenUnits: j['frozen_units'] as String);

  final String token;
  final String units;
  final String frozenUnits;

  @override
  List<Object?> get props => [token, units, frozenUnits];
}

class Subscription extends Equatable {
  const Subscription({
    required this.id,
    required this.units,
    required this.amountPaisa,
    required this.status,
    required this.createdAt,
  });

  factory Subscription.fromJson(Map<String, dynamic> j) => Subscription(
    id: j['id'] as String,
    units: j['units'] as String,
    amountPaisa: (j['amount'] as Map<String, dynamic>)['amount'] as String,
    status: j['status'] as String,
    createdAt: DateTime.parse(j['created_at'] as String),
  );

  final String id;
  final String units;
  final String amountPaisa;
  final String status;
  final DateTime createdAt;

  @override
  List<Object?> get props => [id, status];
}

class Portfolio extends Equatable {
  const Portfolio({required this.holdings, required this.subscriptions, required this.asOfBlock});

  final List<Holding> holdings;
  final List<Subscription> subscriptions;
  final String? asOfBlock;

  @override
  List<Object?> get props => [holdings, subscriptions, asOfBlock];
}

abstract interface class PortfolioRepository {
  Future<Portfolio> portfolio();
}
