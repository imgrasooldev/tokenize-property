import 'dart:async';
import 'dart:math';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/invest/domain/invest.dart';

/// Where an app reservation stands (phase 2a): the investor enters units, the
/// app asks, the investor confirms on the website, the app shows how to pay.
sealed class InvestState extends Equatable {
  const InvestState();
  @override
  List<Object?> get props => [];
}

class InvestEditing extends InvestState {
  const InvestEditing({this.error});

  /// The problem code of the last refused attempt (for example offering_not_open).
  final String? error;
  @override
  List<Object?> get props => [error];
}

class InvestSubmitting extends InvestState {
  const InvestSubmitting();
}

/// Waiting for the investor to confirm the request on the website.
class InvestWaiting extends InvestState {
  const InvestWaiting(this.request);
  final SubscriptionRequest request;
  @override
  List<Object?> get props => [request];
}

/// Confirmed: the subscription and its payment instructions.
class InvestConfirmed extends InvestState {
  const InvestConfirmed(this.request, this.subscription);
  final SubscriptionRequest request;
  final SubscriptionDetail subscription;
  @override
  List<Object?> get props => [request, subscription];
}

/// Declined on the website or expired.
class InvestEnded extends InvestState {
  const InvestEnded(this.status);
  final String status;
  @override
  List<Object?> get props => [status];
}

class InvestCubit extends Cubit<InvestState> {
  /// [pollEvery] null disables the timer (tests call [refresh] themselves).
  InvestCubit(this._repo, {required this.offeringId, this.pollEvery = const Duration(seconds: 3)}) : super(const InvestEditing());

  final InvestRepository _repo;
  final String offeringId;
  final Duration? pollEvery;
  Timer? _timer;

  /// One key per attempt: a retried tap returns the same request (no duplicate).
  String _key = _newKey();

  static String _newKey() {
    final r = Random.secure();
    return 'app-${List.generate(16, (_) => r.nextInt(16).toRadixString(16)).join()}';
  }

  Future<void> submit(String units) async {
    if (!RegExp(r'^[1-9][0-9]{0,12}$').hasMatch(units.trim())) {
      emit(const InvestEditing(error: 'invalid_units'));
      return;
    }
    emit(const InvestSubmitting());
    try {
      final r = await _repo.requestReservation(offeringId: offeringId, units: units.trim(), idempotencyKey: _key);
      _key = _newKey();
      await _show(r);
    } on ApiException catch (e) {
      emit(InvestEditing(error: e.code));
    }
  }

  /// Asks the API where the request stands (the timer calls this).
  Future<void> refresh() async {
    final s = state;
    if (s is! InvestWaiting) return;
    try {
      await _show(await _repo.request(s.request.id));
    } on ApiException {
      // Keep waiting; the next poll tries again.
    }
  }

  Future<void> _show(SubscriptionRequest r) async {
    if (r.status == 'confirmed' && r.subscriptionId != null) {
      _timer?.cancel();
      emit(InvestConfirmed(r, await _repo.subscription(r.subscriptionId!)));
    } else if (r.pending) {
      emit(InvestWaiting(r));
      if (_timer == null && pollEvery != null) _timer = Timer.periodic(pollEvery!, (_) => unawaited(refresh()));
    } else {
      _timer?.cancel();
      emit(InvestEnded(r.status));
    }
  }

  /// Back to the form (after a declined or expired request).
  void restart() {
    _timer?.cancel();
    _timer = null;
    emit(const InvestEditing());
  }

  @override
  Future<void> close() {
    _timer?.cancel();
    return super.close();
  }
}
