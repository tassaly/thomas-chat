# app/jobs/thomas_webhook_job.rb
#
# Fires when Thomas (user ID 1376) is assigned as sales rep to an inquiry.
# Add THOMAS_SERVER_URL and THOMAS_WEBHOOK_SECRET to your Rails credentials/env.
#
# THOMAS_SERVER_URL=https://thomas-chat-production.up.railway.app
# THOMAS_WEBHOOK_SECRET=<shared secret — set the same value in Railway env vars>

class ThomasWebhookJob < ApplicationJob
  queue_as :default

  THOMAS_USER_ID = 1376

  def perform(inquiry_id)
    uri = URI("#{ENV['THOMAS_SERVER_URL']}/assign")

    Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https') do |http|
      request = Net::HTTP::Post.new(uri)
      request['Content-Type'] = 'application/json'
      request['X-Webhook-Secret'] = ENV['THOMAS_WEBHOOK_SECRET']
      request.body = { inquiry_id: inquiry_id }.to_json
      response = http.request(request)
      Rails.logger.info "[Thomas] POST /assign for inquiry #{inquiry_id} — #{response.code}"
    end
  end
end
