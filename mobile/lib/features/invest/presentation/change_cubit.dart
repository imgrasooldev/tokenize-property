import 'dart:async';
import 'dart:math';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/invest/domain/invest.dart';

/// Where a cancel or withdraw request stands (phase 2b, ADR 0018 amendment 2):
/// the investor asks here and confirms on the website; nothing changes before.
sealed class ChangeState extends Equatable {
  const ChangeState();
  @override
  List<Object?> get props => [];
}

class ChangeIdle extends ChangeState {
  const ChangeIdle({this.error});

  /// The problem code of the last refused attempt (for example not_allowed_now).
  final String? error;
  @override
  List<Object?> get props => [error];
}

class ChangeSubmitting extends ChangeState {
  const ChangeSubmitting();
}

/// Waiting for the investor to confirm the request on the website.
class ChangeWaiting extends ChangeState {
  const ChangeWaiting(this.request);
  final SubscriptionRequest request;
  @override
  List<Object?> get props => [request];
}

/// The website confirmed: the subscription is cancelled or being refunded.
class ChangeDone extends ChangeState {
  const ChangeDone(this.request);
  final SubscriptionRequest request;
  @override
  List<Object?> get props => [request];
}

/// Declined on the website or expired: nothing changed.
class ChangeEnded extends ChangeState {
  const ChangeEnded(this.status);
  final String status;
  @override
  List<Object?> get props => [status];
}

class ChangeCubit extends Cubit<ChangeState> {
  /// [pollEvery] null disables the timer (tests call [refresh] themselves).
  ChangeCubit(this._repo, {required this.subscriptionId, this.pollEvery = const Duration(seconds: 3)})
    : super(const ChangeIdle());

  final InvestRepository _repo;
  final String subscriptionId;
  final Duration? pollEvery;
  Timer? _timer;

  /// One key per attempt: a retried tap returns the same request (no duplicate).
  String _key = _newKey();

  static String _newKey() {
    final r = Random.secure();
    return 'app-${List.generate(16, (_) => r.nextInt(16).toRadixString(16)).join()}';
  }

  /// [action] is cancel or withdraw.
  Future<void> ask(String action) async {
    emit(const ChangeSubmitting());
    try {
      final r = await _repo.requestChange(subscriptionId: subscriptionId, action: action, idempotencyKey: _key);
      _key = _newKey();
      _show(r);
    } on ApiException catch (e) {
      // A refusal (4xx) is final for this key; a network failure keeps it for the retry.
      if (e.status >= 400 && e.status < 500) _key = _newKey();
      emit(ChangeIdle(error: e.code));
    }
  }

  /// Asks the API where the request stands (the timer calls this).
  Future<void> refresh() async {
    final s = state;
    if (s is! ChangeWaiting) return;
    try {
      _show(await _repo.request(s.request.id));
    } on ApiException {
      // Keep waiting; the next poll tries again.
    }
  }

  void _show(SubscriptionRequest r) {
    if (r.status == 'confirmed') {
      _timer?.cancel();
      emit(ChangeDone(r));
    } else if (r.pending) {
      emit(ChangeWaiting(r));
      if (_timer == null && pollEvery != null) _timer = Timer.periodic(pollEvery!, (_) => unawaited(refresh()));
    } else {
      _timer?.cancel();
      emit(ChangeEnded(r.status));
    }
  }

  @override
  Future<void> close() {
    _timer?.cancel();
    return super.close();
  }
}
