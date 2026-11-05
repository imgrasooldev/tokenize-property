import 'package:property_token_app/core/bloc/loader_bloc.dart';
import 'package:property_token_app/features/market/domain/market.dart';

class MarketBloc extends LoaderBloc<MarketData> {
  MarketBloc(MarketRepository repo) : super(repo.overview);
}
