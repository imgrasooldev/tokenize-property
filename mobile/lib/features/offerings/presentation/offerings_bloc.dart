import 'package:property_token_app/core/bloc/loader_bloc.dart';
import 'package:property_token_app/features/offerings/domain/offering.dart';

class OfferingsBloc extends LoaderBloc<List<Offering>> {
  OfferingsBloc(OfferingsRepository repo) : super(repo.offerings);
}
