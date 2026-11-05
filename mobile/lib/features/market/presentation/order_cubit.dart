import 'dart:async';
import 'dart:math';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:property_token_app/core/network/api_client.dart';
import 'package:property_token_app/features/market/domain/market.dart';

/// Where an order request stands (ADR 0018 amendment 3): the investor enters
/// side, price and tokens, the app asks, the investor confirms on the website.
sealed class OrderState extends Equatable {
  const OrderState();
  @override
  List<Object?> get props => [];
}

class OrderEditing extends OrderState {
  const OrderEditing({this.error});

  /// invalid_order, or the problem code of the last refused attempt.
  final String? error;
  @override
  List<Object?> get props => [error];
}

class OrderSubmitting extends OrderState {
  const OrderSubmitting();
}

class OrderWaiting extends OrderState {
  const OrderWaiting(this.request);
  final OrderRequest request;
  @override
  List<Object?> get props => [request];
}

/// The website placed the order (or, for a cancellation, cancelled it).
class OrderPlaced extends OrderState {
  const OrderPlaced(this.request);
  final OrderRequest request;
  @override
  List<Object?> get props => [request];
}

/// Declined on the website or expired: no order was placed.
class OrderEnded extends OrderState {
  const OrderEnded(this.status);
  final String status;
  @override
  List<Object?> get props => [status];
}

class OrderCubit extends Cubit<OrderState> {
  /// [pollEvery] null disables the timer (tests call [refresh] themselves).
  OrderCubit(this._repo, {required this.symbol, this.pollEvery = const Duration(seconds: 3)})
    : super(const OrderEditing());

  final MarketRepository _repo;
  final String symbol;
  final Duration? pollEvery;
  Timer? _timer;

  /// One key per attempt: a retried tap returns the same request (no duplicate).
  String _key = _newKey();

  static String _newKey() {
    final r = Random.secure();
    return 'app-${List.generate(16, (_) => r.nextInt(16).toRadixString(16)).join()}';
  }

  /// [side] is buy or sell; [price] in rupees (up to 2 decimals); [tokens] a whole number.
  Future<void> submit({required String side, required String price, required String tokens}) async {
    final paisa = rupeesToPaisa(price);
    if (paisa == null || !RegExp(r'^[1-9][0-9]{0,5}$').hasMatch(tokens.trim())) {
      emit(const OrderEditing(error: 'invalid_order'));
      return;
    }
    emit(const OrderSubmitting());
    try {
      final r = await _repo.requestOrder(
        symbol: symbol,
        side: side,
        pricePaisa: paisa,
        tokens: tokens.trim(),
        idempotencyKey: _key,
      );
      _key = _newKey();
      _show(r);
    } on ApiException catch (e) {
      // A refusal (4xx) is final for this key; a network failure keeps it for the retry.
      if (e.status >= 400 && e.status < 500) _key = _newKey();
      emit(OrderEditing(error: e.code));
    }
  }

  /// Asks to cancel the investor's open order [orderId] (ADR 0018 amendment 4);
  /// the investor confirms on the website, then [OrderPlaced] carries the result.
  Future<void> cancelOrder(String orderId) async {
    emit(const OrderSubmitting());
    try {
      final r = await _repo.requestOrderCancel(orderId: orderId, idempotencyKey: _key);
      _key = _newKey();
      _show(r);
    } on ApiException catch (e) {
      if (e.status >= 400 && e.status < 500) _key = _newKey();
      emit(OrderEditing(error: e.code));
    }
  }

  /// Asks the API where the request stands (the timer calls this).
  Future<void> refresh() async {
    final s = state;
    if (s is! OrderWaiting) return;
    try {
      _show(await _repo.orderRequest(s.request.id));
    } on ApiException {
      // Keep waiting; the next poll tries again.
    }
  }

  void _show(OrderRequest r) {
    if (r.status == 'confirmed') {
      _timer?.cancel();
      emit(OrderPlaced(r));
    } else if (r.pending) {
      emit(OrderWaiting(r));
      if (_timer == null && pollEvery != null) _timer = Timer.periodic(pollEvery!, (_) => unawaited(refresh()));
    } else {
      _timer?.cancel();
      emit(OrderEnded(r.status));
    }
  }

  /// Back to the form (after a declined or expired request).
  void restart() {
    _timer?.cancel();
    _timer = null;
    emit(const OrderEditing());
  }

  @override
  Future<void> close() {
    _timer?.cancel();
    return super.close();
  }
}
