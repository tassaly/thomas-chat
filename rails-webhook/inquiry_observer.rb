# app/models/concerns/thomas_assignable.rb
#
# Include in the Inquiry model:
#   include ThomasAssignable
#
# This fires ThomasWebhookJob whenever Thomas (user ID 1376) is newly
# assigned as sales rep to an inquiry.

module ThomasAssignable
  extend ActiveSupport::Concern

  THOMAS_USER_ID = 1376

  included do
    after_save :notify_thomas_if_assigned
  end

  private

  def notify_thomas_if_assigned
    return unless saved_change_to_sales_rep_id?
    return unless sales_rep_id == THOMAS_USER_ID

    ThomasWebhookJob.perform_later(id)
  end
end
