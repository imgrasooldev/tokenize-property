import 'dart:async';
import 'dart:math';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/market/domain/market.dart';

/// Where a demo cash top-up stands (ADR 0018 amendment 5): the investor
/// enters whole rupees, the app asks, the investor confirms on the website.
sealed class TopUpState extends Equatable {
  const TopUpState();
  @override
  List<Object?> get props => [];
}

class TopUpEditing extends TopUpState {
  const TopUpEditing({this.error});

  /// invalid_amount, or the problem code of the last refused attempt.
  final String? error;
  @override
  List<Object?> get props => [error];
}

class TopUpSubmitting extends TopUpState {
  const TopUpSubmitting();
}

class TopUpWaiting extends TopUpState {
  const TopUpWaiting(this.request);
  final TopUpRequest request;
  @override
  List<Object?> get props => [request];
}

/// The website added the cash.
class TopUpDone extends TopUpState {
  const TopUpDone(this.request);
  final TopUpRequest request;
  @override
  List<Object?> get props => [request];
}

/// Declined on the website or expired: no cash was added.
class TopUpEnded extends TopUpState {
  const TopUpEnded(this.status);
  final String status;
  @override
  List<Object?> get props => [status];
}

class TopUpCubit extends Cubit<TopUpState> {
  /// [pollEvery] null disables the timer (tests call [refresh] themselves).
  TopUpCubit(this._repo, {this.pollEvery = const Duration(seconds: 3)}) : super(const TopUpEditing());

  final MarketRepository _repo;
  final Duration? pollEvery;
  Timer? _timer;

  /// One key per attempt: a retried tap returns the same request (no duplicate).
  String _key = _newKey();

  static String _newKey() {
    final r = Random.secure();
    return 'app-${List.generate(16, (_) => r.nextInt(16).toRadixString(16)).join()}';
  }

  /// [rupees] whole rupees, Rs 1 to Rs 10,000,000.
  Future<void> submit(String rupees) async {
    final text = rupees.trim();
    if (!RegExp(r'^[1-9][0-9]{0,7}$').hasMatch(text) || BigInt.parse(text) > BigInt.from(10000000)) {
      emit(const TopUpEditing(error: 'invalid_amount'));
      return;
    }
    emit(const TopUpSubmitting());
    try {
      final r = await _repo.requestTopUp(amountPaisa: '${text}00', idempotencyKey: _key);
      _key = _newKey();
      _show(r);
    } on ApiException catch (e) {
      // A refusal (4xx) is final for this key; a network failure keeps it for the retry.
      if (e.status >= 400 && e.status < 500) _key = _newKey();
      emit(TopUpEditing(error: e.code));
    }
  }

  /// Asks the API where the request stands (the timer calls this).
  Future<void> refresh() async {
    final s = state;
    if (s is! TopUpWaiting) return;
    try {
      _show(await _repo.topUpRequest(s.request.id));
    } on ApiException {
      // Keep waiting; the next poll tries again.
    }
  }

  void _show(TopUpRequest r) {
    if (r.status == 'confirmed') {
      _timer?.cancel();
      emit(TopUpDone(r));
    } else if (r.pending) {
      emit(TopUpWaiting(r));
      if (_timer == null && pollEvery != null) _timer = Timer.periodic(pollEvery!, (_) => unawaited(refresh()));
    } else {
      _timer?.cancel();
      emit(TopUpEnded(r.status));
    }
  }

  @override
  Future<void> close() {
    _timer?.cancel();
    return super.close();
  }
}
