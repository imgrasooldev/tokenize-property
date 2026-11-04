import 'package:equatable/equatable.dart';

/// An offering of the public catalogue (schema Offering of docs/api/openapi.json).
class Offering extends Equatable {
  const Offering({
    required this.id,
    required this.state,
    required this.building,
    required this.district,
    required this.province,
    required this.use,
    required this.pricePaisa,
    required this.hardCapUnits,
    required this.availableUnits,
    required this.closesAt,
  });

  factory Offering.fromJson(Map<String, dynamic> j) {
    final units = j['units'] as Map<String, dynamic>;
    final price = j['price'] as Map<String, dynamic>;
    return Offering(
      id: j['id'] as String,
      state: j['state'] as String,
      building: j['building'] as String?,
      district: j['district'] as String?,
      province: j['province'] as String?,
      use: j['use'] as String?,
      pricePaisa: price['amount'] as String,
      hardCapUnits: units['hard_cap'] as String,
      availableUnits: units['available'] as String,
      closesAt: j['closes_at'] == null ? null : DateTime.parse(j['closes_at'] as String),
    );
  }

  final String id;
  final String state;
  final String? building;
  final String? district;
  final String? province;
  final String? use;
  final String pricePaisa;
  final String hardCapUnits;
  final String availableUnits;
  final DateTime? closesAt;

  String get title => building ?? district ?? 'Offering';

  @override
  List<Object?> get props => [id, state, availableUnits];
}

abstract interface class OfferingsRepository {
  Future<List<Offering>> offerings();
}
